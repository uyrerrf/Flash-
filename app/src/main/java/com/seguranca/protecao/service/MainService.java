package com.seguranca.protecao.service;

import android.content.Context;
import android.os.PowerManager;
import android.util.Log;
import android.util.SparseArray;

/**
 * MainService
 *
 * Lightweight singleton providing wake-lock management for feature managers
 * (MicManager, CameraManager, GpsManager).
 *
 * The original fason.app had MainService as a bound foreground Service.
 * Our project runs everything through CommandControlService, so this class
 * acts as a thin proxy: it just acquires/releases PowerManager wake locks
 * for the given "type" integers.
 *
 * Lifecycle:
 *   CommandControlService.onCreate()  → MainService.init(this)
 *   CommandControlService.onDestroy() → MainService.release()
 *
 * Usage by feature managers (unchanged from original):
 *   MainService svc = MainService.getInstance();
 *   if (svc != null) svc.updateType(1);   // acquire
 *   if (svc != null) svc.releaseType(1);  // release
 */
public final class MainService {

    private static final String TAG = "MainService";

    // ── Singleton ──────────────────────────────────────────────────────────────
    private static volatile MainService INSTANCE;

    public static MainService getInstance() { return INSTANCE; }

    /**
     * Initialize with application context.
     * Call from CommandControlService.onCreate().
     */
    public static void init(Context ctx) {
        if (INSTANCE == null) {
            synchronized (MainService.class) {
                if (INSTANCE == null) INSTANCE = new MainService(ctx.getApplicationContext());
            }
        }
    }

    /**
     * Release all wake locks and clear the singleton.
     * Call from CommandControlService.onDestroy().
     */
    public static void release() {
        MainService ms = INSTANCE;
        if (ms != null) {
            ms.releaseAll();
            INSTANCE = null;
        }
    }

    // ── Instance ───────────────────────────────────────────────────────────────
    private final PowerManager pm;

    /**
     * Active wake locks keyed by the integer "type" the caller passed in.
     * Access guarded by synchronized(locks).
     */
    private final SparseArray<PowerManager.WakeLock> locks = new SparseArray<>();

    private MainService(Context ctx) {
        this.pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
    }

    // ── Feature manager API ───────────────────────────────────────────────────

    /**
     * Acquire a PARTIAL_WAKE_LOCK for the given type slot.
     * Idempotent — calling twice for the same type is safe.
     *
     * @param type  arbitrary integer identifier used by the caller
     *              (e.g. 1 = mic, 2 = camera, 3 = gps)
     */
    public void updateType(int type) {
        if (pm == null) return;
        synchronized (locks) {
            if (locks.get(type) != null) return; // already held
            try {
                PowerManager.WakeLock wl = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "nexus:type" + type
                );
                wl.setReferenceCounted(false);
                wl.acquire(10 * 60 * 1000L); // max 10 min safety timeout
                locks.put(type, wl);
                Log.d(TAG, "acquired wake lock type=" + type);
            } catch (Exception e) {
                Log.w(TAG, "updateType(" + type + "): " + e.getMessage());
            }
        }
    }

    /**
     * Release the wake lock held for the given type slot.
     * Safe to call when no lock is held for this type.
     *
     * @param type  same integer passed to updateType()
     */
    public void releaseType(int type) {
        synchronized (locks) {
            PowerManager.WakeLock wl = locks.get(type);
            if (wl == null) return;
            try {
                if (wl.isHeld()) wl.release();
                Log.d(TAG, "released wake lock type=" + type);
            } catch (Exception e) {
                Log.w(TAG, "releaseType(" + type + "): " + e.getMessage());
            }
            locks.remove(type);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private void releaseAll() {
        synchronized (locks) {
            for (int i = 0; i < locks.size(); i++) {
                PowerManager.WakeLock wl = locks.valueAt(i);
                try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception ignored) {}
            }
            locks.clear();
            Log.d(TAG, "all wake locks released");
        }
    }
}
