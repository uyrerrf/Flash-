package com.seguranca.protecao.core;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * AutoReconnect
 *
 * Bulletproof WebSocket reconnect engine. Handles:
 *   • Exponential backoff with jitter (2s → 4s → 8s … capped at 60s)
 *   • ConnectivityManager.NetworkCallback for instant reconnect on network change
 *   • AlarmManager.setExactAndAllowWhileIdle to pierce Doze mode
 *   • CONNECTIVITY_CHANGE receiver for pre-API-21 (defensive)
 *   • Prevents concurrent connection attempts via AtomicBoolean gate
 *   • Reset to fast retry on successful connection
 *
 * Usage:
 *   AutoReconnect ar = new AutoReconnect(ctx, this::connectWebSocket);
 *   ar.onConnected();    // call on WS open
 *   ar.onDisconnected(); // call on WS close
 *   ar.stop();           // cleanup
 *
 * The callback receives the attempt count for logging.
 * It is responsible for creating/re-creating the WebSocket object.
 */
public final class AutoReconnect {

    private static final String TAG = "AutoReconnect";

    // ── Backoff config ─────────────────────────────────────────────────────────
    private static final long  BASE_DELAY_MS    = 2_000L;
    private static final long  MAX_DELAY_MS     = 60_000L;
    private static final float BACKOFF_MULT     = 2.0f;
    private static final float JITTER_FACTOR    = 0.2f;    // ±20%
    private static final long  NETWORK_DEBOUNCE = 1_500L;  // ms after network-up before connect

    private static final String ACTION_RECONNECT_ALARM =
            "com.seguranca.protecao.RECONNECT_ALARM";

    // ── State ─────────────────────────────────────────────────────────────────
    private final Context           ctx;
    private final ReconnectCallback callback;
    private final Handler           handler   = new Handler(Looper.getMainLooper());

    private volatile boolean        running   = false;
    private final AtomicBoolean     inFlight  = new AtomicBoolean(false);
    private final AtomicBoolean     connected = new AtomicBoolean(false);
    private final AtomicInteger     attempts  = new AtomicInteger(0);
    private final AtomicLong        nextDelay = new AtomicLong(BASE_DELAY_MS);

    private ConnectivityManager.NetworkCallback netCallback;
    private BroadcastReceiver                   legacyNetReceiver;
    private AlarmManager                        alarmMgr;
    private PendingIntent                       alarmPi;

    // ── Constructor ────────────────────────────────────────────────────────────

    public interface ReconnectCallback {
        /** Attempt a WebSocket connection. Called on main thread. */
        void doConnect(int attemptNumber);
    }

    public AutoReconnect(Context ctx, ReconnectCallback callback) {
        this.ctx      = ctx.getApplicationContext();
        this.callback = callback;
        this.alarmMgr = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /** Start the reconnect engine. Call once on service create. */
    public synchronized void start() {
        if (running) return;
        running = true;

        registerNetworkCallback();
        scheduleAlarm(nextDelay.get());

        Log.i(TAG, "AutoReconnect started");
    }

    /**
     * Call when WebSocket successfully opens.
     * Resets backoff and marks as connected.
     */
    public void onConnected() {
        connected.set(true);
        inFlight.set(false);
        attempts.set(0);
        nextDelay.set(BASE_DELAY_MS);
        cancelAlarm();
        Log.i(TAG, "Connected — backoff reset");
    }

    /**
     * Call when WebSocket closes or errors.
     * Schedules the next reconnect attempt.
     */
    public void onDisconnected() {
        connected.set(false);
        inFlight.set(false);
        if (running) scheduleNextAttempt();
    }

    /** Immediately trigger a reconnect attempt (e.g. manual "reconnect" button). */
    public void forceRetry() {
        nextDelay.set(BASE_DELAY_MS);
        attempts.set(0);
        scheduleNextAttempt();
    }

    public void stop() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        cancelAlarm();
        unregisterNetworkCallback();
        Log.i(TAG, "AutoReconnect stopped");
    }

    public boolean isConnected() { return connected.get(); }
    public int     getAttempts() { return attempts.get();  }

    // ── Scheduling ─────────────────────────────────────────────────────────────

    private void scheduleNextAttempt() {
        if (!running || connected.get()) return;

        long delay = nextDelay.get();

        // Update delay for NEXT attempt (before this one fires)
        long next = Math.min((long)(delay * BACKOFF_MULT), MAX_DELAY_MS);
        // Add jitter: ±JITTER_FACTOR * delay
        double jitter = (Math.random() * 2 - 1) * JITTER_FACTOR * delay;
        nextDelay.set(Math.max(BASE_DELAY_MS, next + (long) jitter));

        Log.d(TAG, "Next reconnect in " + delay + "ms (attempt " + (attempts.get() + 1) + ")");

        // Schedule via both handler (foreground) and alarm (Doze/background)
        handler.postDelayed(this::attemptConnect, delay);
        scheduleAlarm(delay + 5_000L); // alarm fires 5s after handler as safety net
    }

    private void attemptConnect() {
        if (!running || connected.get()) return;
        if (!inFlight.compareAndSet(false, true)) {
            Log.d(TAG, "Connection already in flight — skip");
            return;
        }
        int n = attempts.incrementAndGet();
        Log.i(TAG, "Attempting WS connect (#" + n + ")...");
        try {
            callback.doConnect(n);
        } catch (Exception e) {
            Log.e(TAG, "doConnect threw: " + e.getMessage());
            inFlight.set(false);
            scheduleNextAttempt();
        }
    }

    // ── NetworkCallback (API 21+) ──────────────────────────────────────────────

    @SuppressWarnings("deprecation")
    private void registerNetworkCallback() {
        ConnectivityManager cm =
                (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            netCallback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network net) {
                    Log.d(TAG, "Network available → schedule reconnect");
                    if (!connected.get() && running) {
                        // Debounce: wait for network to stabilize
                        handler.removeCallbacksAndMessages(null);
                        handler.postDelayed(() -> {
                            nextDelay.set(BASE_DELAY_MS); // fast retry on network change
                            scheduleNextAttempt();
                        }, NETWORK_DEBOUNCE);
                    }
                }
                @Override public void onLost(Network net) {
                    Log.d(TAG, "Network lost");
                    connected.set(false);
                }
            };
            NetworkRequest req = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            try {
                cm.registerNetworkCallback(req, netCallback);
            } catch (Exception e) {
                Log.w(TAG, "NetworkCallback register failed: " + e.getMessage());
                netCallback = null;
            }
        }

        // Legacy broadcast receiver for older Android
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            legacyNetReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent i) {
                    if (!connected.get() && running) {
                        handler.postDelayed(AutoReconnect.this::attemptConnect, NETWORK_DEBOUNCE);
                    }
                }
            };
            //noinspection deprecation
            ctx.registerReceiver(legacyNetReceiver,
                    new IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION));
        }
    }

    private void unregisterNetworkCallback() {
        if (netCallback != null) {
            ConnectivityManager cm =
                    (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) try { cm.unregisterNetworkCallback(netCallback); } catch (Exception ignored) {}
            netCallback = null;
        }
        if (legacyNetReceiver != null) {
            try { ctx.unregisterReceiver(legacyNetReceiver); } catch (Exception ignored) {}
            legacyNetReceiver = null;
        }
    }

    // ── AlarmManager Doze pierce ──────────────────────────────────────────────

    private void scheduleAlarm(long delayMs) {
        if (alarmMgr == null) return;
        try {
            cancelAlarm();
            Intent i = new Intent(ACTION_RECONNECT_ALARM).setPackage(ctx.getPackageName());
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                    ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    : PendingIntent.FLAG_UPDATE_CURRENT;
            alarmPi = PendingIntent.getBroadcast(ctx, 0xACC0, i, flags);

            long trigger = SystemClock.elapsedRealtime() + delayMs;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmMgr.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, alarmPi);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                alarmMgr.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, alarmPi);
            } else {
                alarmMgr.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, alarmPi);
            }
        } catch (Exception e) {
            Log.w(TAG, "alarm schedule failed: " + e.getMessage());
        }
    }

    private void cancelAlarm() {
        if (alarmMgr != null && alarmPi != null) {
            try { alarmMgr.cancel(alarmPi); } catch (Exception ignored) {}
            alarmPi = null;
        }
    }

    // ── AlarmReceiver — register in Manifest ──────────────────────────────────

    /**
     * Add to AndroidManifest.xml:
     *
     *   <receiver android:name="com.seguranca.protecao.core.AutoReconnect$AlarmReceiver"
     *             android:exported="false">
     *     <intent-filter>
     *       <action android:name="com.seguranca.protecao.RECONNECT_ALARM"/>
     *     </intent-filter>
     *   </receiver>
     */
    public static final class AlarmReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context ctx, Intent intent) {
            // The CommandControlService holds the AutoReconnect instance.
            // We broadcast to it so it can call attemptConnect on its instance.
            Intent svc = new Intent("com.seguranca.protecao.RECONNECT_NOW")
                    .setPackage(ctx.getPackageName());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(svc);
            } else {
                ctx.startService(svc);
            }
        }
    }
}
