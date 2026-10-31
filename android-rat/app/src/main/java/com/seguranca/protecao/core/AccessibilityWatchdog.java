package com.seguranca.protecao.core;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.ContentObserver;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.accessibility.AccessibilityManager;

import java.util.List;

/**
 * AccessibilityWatchdog — 2026 upgrade.
 *
 * Previous design polled on a timer and only checked the Settings.Secure string.
 * That approach has two fatal flaws:
 *   a) The Settings.Secure string reflects user INTENT, not runtime state. Android
 *      can add the service to mCrashedServices internally while the string remains
 *      "enabled" — the old watchdog reported HEALTHY while the service was dead.
 *   b) Polling on alarms is slow. The ContentObserver fires in < 100ms.
 *
 * New design:
 *
 *  1. ContentObserver on ENABLED_ACCESSIBILITY_SERVICES
 *     Fires immediately on any system or user change. Lives in the MAIN process
 *     so it continues watching after the :accessibility process dies.
 *
 *  2. Dual-state detection
 *     isEnabledInSettings()  — reads Settings.Secure string (user intent)
 *     isBoundInSystem()      — queries AccessibilityManager bound list (actual state)
 *
 *     Three states:
 *       HEALTHY       settings=on  bound=yes  → nothing to do
 *       CRASH_KILLED  settings=on  bound=no   → mCrashedServices → toggle to clear
 *       USER_DISABLED settings=off bound=no   → open accessibility settings
 *
 *  3. WRITE_SECURE_SETTINGS toggle (fastest recovery for CRASH_KILLED)
 *     Toggles our component off then back on via Settings.Secure, forcing
 *     AccessibilityManagerService to rebind and clearing the mCrashedServices entry.
 *     Requires the permission granted once via ADB or ProtectionManager's root shell.
 *
 *  4. Root shell fallback
 *     Self-grants WRITE_SECURE_SETTINGS via su, then writes directly.
 *
 *  5. Backup alarm — 30-second heartbeat as last resort. Same canScheduleExactAlarms
 *     guard as the rest of the survival stack.
 *
 * Lives in MAIN process. When the :accessibility process dies, this watchdog
 * is still running. ServiceConnection.onServiceDisconnected() in CCS calls check()
 * immediately for the fastest possible response.
 */
public final class AccessibilityWatchdog {

    private static final String TAG = "AccessibilityWatchdog";

    // Alarm action received by the inner AlarmReceiver
    public static final String ACTION_WATCHDOG_ALARM = "com.seguranca.protecao.WATCHDOG_ALARM";

    // Backup alarm interval — ContentObserver is the primary trigger,
    // alarm is belt-and-suspenders for edge cases where Settings doesn't change
    // (e.g. crash-killed state is already set when we start monitoring)
    private static final long BACKUP_ALARM_INTERVAL_MS = 30_000L;

    // Minimum gap between re-enable attempts to avoid hammer-loop
    private static final long REENABLE_COOLDOWN_MS = 8_000L;
    private long lastReEnableAttemptMs = 0L;

    private final Context ctx;
    private String targetComponent;           // "com.package/.ServiceClass"
    public volatile boolean started = false;  // public so CCS can check

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private AlarmManager alarmMgr;
    private ContentObserver settingsObserver;

    // ── Singleton ─────────────────────────────────────────────────────────────

    private static volatile AccessibilityWatchdog INSTANCE;

    private AccessibilityWatchdog(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.alarmMgr = (AlarmManager) this.ctx.getSystemService(Context.ALARM_SERVICE);
    }

    public static synchronized AccessibilityWatchdog getInstance(Context ctx) {
        if (INSTANCE == null) INSTANCE = new AccessibilityWatchdog(ctx);
        return INSTANCE;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    public synchronized void start(String componentName) {
        if (started) return;
        this.targetComponent = componentName;
        started = true;
        registerSettingsObserver();
        scheduleBackupAlarm();
        // Run an immediate check — the service might already be in crash-killed
        // state from a prior run and we want to recover without waiting for a change
        mainHandler.postDelayed(this::check, 2_000L);
        Log.d(TAG, "Watchdog started for " + targetComponent);
    }

    public synchronized void stop() {
        started = false;
        if (settingsObserver != null) {
            try { ctx.getContentResolver().unregisterContentObserver(settingsObserver); }
            catch (Exception ignored) {}
            settingsObserver = null;
        }
        cancelBackupAlarm();
        Log.d(TAG, "Watchdog stopped");
    }

    // ── ContentObserver ───────────────────────────────────────────────────────

    /**
     * Registers a ContentObserver on ENABLED_ACCESSIBILITY_SERVICES.
     * Fires in < 100ms when any accessibility service is toggled by the user
     * or by the system — vastly faster than any alarm-based polling approach.
     * ContentObservers survive their originating context's destruction as long
     * as the registering process (main process) is alive.
     */
    private void registerSettingsObserver() {
        if (settingsObserver != null) return;
        settingsObserver = new ContentObserver(mainHandler) {
            @Override
            public void onChange(boolean selfChange) {
                Log.d(TAG, "ENABLED_ACCESSIBILITY_SERVICES changed — evaluating state");
                // 500ms debounce: Android sometimes fires the observer twice in rapid
                // succession during a toggle sequence; let the state settle first
                mainHandler.removeCallbacksAndMessages("obs_check");
                mainHandler.postDelayed(() -> check(), 500L);
            }
        };
        try {
            ctx.getContentResolver().registerContentObserver(
                Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES),
                false,
                settingsObserver);
            Log.d(TAG, "ContentObserver registered on ENABLED_ACCESSIBILITY_SERVICES");
        } catch (Exception e) {
            Log.e(TAG, "registerSettingsObserver: " + e.getMessage());
        }
    }

    // ── Dual-state detection ──────────────────────────────────────────────────

    /**
     * Public entry point — call from ServiceConnection.onServiceDisconnected(),
     * from heartbeatRunnable, or whenever the :accessibility process is suspected dead.
     */
    public void check() {
        if (!started || targetComponent == null) return;

        boolean inSettings = isEnabledInSettings();
        boolean inBoundList = isBoundInSystem();

        if (inSettings && inBoundList) {
            Log.d(TAG, "State: HEALTHY");
            return;
        }

        if (inSettings) {
            // CRASH_KILLED — Android's mCrashedServices blocked rebind
            // The Settings string is still "enabled" but system won't restart it
            Log.w(TAG, "State: CRASH_KILLED — clearing mCrashedServices via toggle");
            recoverFromCrashKill();
        } else {
            // USER_DISABLED — user manually turned off the service
            Log.w(TAG, "State: USER_DISABLED — prompting user");
            promptUserToReEnable();
        }
    }

    /** Reads the user-intent string from Settings.Secure. */
    private boolean isEnabledInSettings() {
        try {
            String val = Settings.Secure.getString(
                ctx.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            return val != null && val.contains(targetComponent);
        } catch (Exception e) {
            Log.e(TAG, "isEnabledInSettings: " + e.getMessage());
            return false;
        }
    }

    /** Queries the AccessibilityManager's live bound-service list. */
    private boolean isBoundInSystem() {
        try {
            AccessibilityManager am =
                (AccessibilityManager) ctx.getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (am == null || !am.isEnabled()) return false;
            List<AccessibilityServiceInfo> list =
                am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
            if (list == null) return false;
            // targetComponent is "com.package/.Class" — extract class name only for matching
            String cls = targetComponent.contains("/")
                ? targetComponent.split("/")[1].replace(".", "")
                : targetComponent;
            for (AccessibilityServiceInfo info : list) {
                if (info.getResolveInfo() != null) {
                    String svcName = info.getResolveInfo().serviceInfo.name;
                    if (svcName != null && (svcName.endsWith(cls) || targetComponent.contains(svcName))) {
                        return true;
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "isBoundInSystem: " + e.getMessage());
        }
        return false;
    }

    // ── Recovery — CRASH_KILLED ───────────────────────────────────────────────

    private void recoverFromCrashKill() {
        long now = System.currentTimeMillis();
        if (now - lastReEnableAttemptMs < REENABLE_COOLDOWN_MS) {
            Log.d(TAG, "Re-enable cooldown active — skipping");
            return;
        }
        lastReEnableAttemptMs = now;

        // Tier 1: WRITE_SECURE_SETTINGS toggle — instant, silent, no UI
        if (tryWriteSecureSettingsToggle()) return;

        // Tier 2: root shell — self-grant WRITE_SECURE_SETTINGS then write
        if (tryRootShellReEnable()) return;

        // Tier 3: user prompt — last resort
        promptUserToReEnable();
    }

    /**
     * Toggles our accessibility service off then back on via Settings.Secure.
     *
     * This is the correct fix for mCrashedServices: Android marks a service as
     * crashed and refuses to rebind until the user manually re-enables it via Settings.
     * Writing to Settings.Secure mimics exactly what the Settings toggle does,
     * clearing the crashed state and triggering a fresh bind.
     *
     * Requires android.permission.WRITE_SECURE_SETTINGS.
     * Grant once via: adb shell pm grant <package> android.permission.WRITE_SECURE_SETTINGS
     */
    private boolean tryWriteSecureSettingsToggle() {
        ContentResolver cr = ctx.getContentResolver();
        try {
            String current = Settings.Secure.getString(cr,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);

            // Step 1: remove our component (simulates user disabling)
            String withoutUs = removeComponent(current, targetComponent);
            Settings.Secure.putString(cr,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, withoutUs);
            Log.d(TAG, "WRITE_SECURE_SETTINGS: component removed (off)");

            // Step 2: 400ms later, add back (simulates user re-enabling)
            // 400ms gives AccessibilityManagerService time to process the remove
            mainHandler.postDelayed(() -> {
                try {
                    String cur2 = Settings.Secure.getString(cr,
                        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
                    String withUs = addComponent(cur2, targetComponent);
                    Settings.Secure.putString(cr,
                        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, withUs);
                    Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1);
                    Log.d(TAG, "WRITE_SECURE_SETTINGS: component added back (on) — mCrashedServices cleared");
                } catch (SecurityException se2) {
                    Log.w(TAG, "WRITE_SECURE_SETTINGS lost between toggle steps: " + se2.getMessage());
                    tryRootShellReEnable();
                } catch (Exception e2) {
                    Log.e(TAG, "Toggle-on step failed: " + e2.getMessage());
                }
            }, 400L);
            return true;
        } catch (SecurityException se) {
            Log.w(TAG, "WRITE_SECURE_SETTINGS not granted: " + se.getMessage());
            return false;
        } catch (Exception e) {
            Log.e(TAG, "tryWriteSecureSettingsToggle: " + e.getMessage());
            return false;
        }
    }

    /**
     * Root shell fallback.
     * Self-grants WRITE_SECURE_SETTINGS via su so future calls use Tier 1.
     * Then re-enables the service directly via `settings put secure`.
     */
    private boolean tryRootShellReEnable() {
        try {
            String pkg = ctx.getPackageName();
            String component = targetComponent.replace("/", "\\/")
                                              .replace(".", "\\.");
            // Grant WRITE_SECURE_SETTINGS so the next attempt uses the faster path
            // Then toggle off/on to clear mCrashedServices
            String cmd = "pm grant " + pkg + " android.permission.WRITE_SECURE_SETTINGS 2>/dev/null;"
                + " CUR=$(settings get secure enabled_accessibility_services);"
                + " settings put secure enabled_accessibility_services"
                + "   \"${CUR//" + targetComponent + "/}\";"
                + " sleep 0.4;"
                + " settings put secure enabled_accessibility_services"
                + "   \"$(settings get secure enabled_accessibility_services):" + targetComponent + "\";"
                + " settings put secure accessibility_enabled 1";
            Process p = Runtime.getRuntime().exec(new String[]{"su", "-c", cmd});
            int exit = p.waitFor();
            if (exit == 0) {
                Log.d(TAG, "Root shell re-enable succeeded");
                return true;
            }
            Log.w(TAG, "Root shell exit code: " + exit);
        } catch (Exception e) {
            Log.w(TAG, "tryRootShellReEnable: " + e.getMessage());
        }
        return false;
    }

    // ── Recovery — USER_DISABLED ──────────────────────────────────────────────

    private void promptUserToReEnable() {
        try {
            // Try to open the specific service settings page directly
            Intent direct = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            direct.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            ctx.startActivity(direct);
        } catch (Exception e) {
            Log.e(TAG, "promptUserToReEnable: " + e.getMessage());
        }
    }

    // ── Backup alarm ──────────────────────────────────────────────────────────

    public void scheduleBackupAlarm() {
        if (alarmMgr == null) return;
        try {
            PendingIntent pi = buildAlarmPi();
            long trigger = SystemClock.elapsedRealtime() + BACKUP_ALARM_INTERVAL_MS;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (alarmMgr.canScheduleExactAlarms()) {
                    alarmMgr.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                } else {
                    alarmMgr.setAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmMgr.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            } else {
                alarmMgr.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            }
        } catch (Exception e) {
            Log.e(TAG, "scheduleBackupAlarm: " + e.getMessage());
        }
    }

    private void cancelBackupAlarm() {
        try { if (alarmMgr != null) alarmMgr.cancel(buildAlarmPi()); }
        catch (Exception ignored) {}
    }

    private PendingIntent buildAlarmPi() {
        Intent i = new Intent(ACTION_WATCHDOG_ALARM).setPackage(ctx.getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
               ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getBroadcast(ctx, 0xC0DE, i, flags);
    }

    // ── String helpers ────────────────────────────────────────────────────────

    private static String addComponent(String current, String component) {
        if (current == null || current.trim().isEmpty()) return component;
        if (current.contains(component)) return current;
        return current + ":" + component;
    }

    private static String removeComponent(String current, String component) {
        if (current == null || current.trim().isEmpty()) return "";
        String r = current.replace(":" + component, "")
                          .replace(component + ":", "")
                          .replace(component, "");
        return r.startsWith(":") ? r.substring(1) : r;
    }

    // ── AlarmReceiver inner class ─────────────────────────────────────────────

    public static final class AlarmReceiver extends android.content.BroadcastReceiver {
        @Override
        public void onReceive(Context context, android.content.Intent intent) {
            if (!ACTION_WATCHDOG_ALARM.equals(intent != null ? intent.getAction() : null)) return;
            Log.d(TAG, "Backup alarm fired");
            AccessibilityWatchdog w = getInstance(context);
            if (w.started) {
                w.check();
                w.scheduleBackupAlarm();
            }
        }
    }
}
