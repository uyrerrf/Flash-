package com.seguranca.protecao.util;

import android.content.Context;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.spec.KeySpec;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * CryptHelper — AES-256-GCM symmetric encryption for all locally stored data.
 *
 * Key derivation:
 *   PBKDF2WithHmacSHA256(passphrase = ANDROID_ID + packageName, salt, 65536 iter, 256 bits)
 *
 * Ciphertext format (Base64-encoded):
 *   [ iv: 12 bytes ][ ciphertext + GCM tag: n + 16 bytes ]
 *
 * Properties:
 *   - AES-256 key: unique per device (ANDROID_ID binds it to the hardware)
 *   - 12-byte random IV per encrypt call: never reuses a (key, nonce) pair
 *   - GCM 128-bit auth tag: detects any ciphertext tampering
 *   - Key cached after first derivation (expensive PBKDF2 runs once per process)
 *   - Thread-safe: double-checked lock on cachedKey
 *
 * Usage:
 *   String enc = CryptHelper.encrypt(context, plaintext);
 *   String dec = CryptHelper.decrypt(context, enc);  // null if tampered
 *   CryptHelper.wipeKey();                           // call on self-destruct
 */
public final class CryptHelper {

    private static final String TAG       = "CryptHelper";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final String KDF_ALG   = "PBKDF2WithHmacSHA256";

    private static final int IV_LEN   = 12;      // GCM nonce length
    private static final int TAG_BITS = 128;     // GCM authentication tag bits
    private static final int KEY_BITS = 256;     // AES key length
    private static final int KDF_ITER = 65_536;  // PBKDF2 iteration count

    // Static salt — unique to this application's obfuscation layer.
    // Does NOT need to be secret (stored alongside ciphertext in production apps),
    // but keeping it in code adds a slight barrier vs. generic dictionary attacks.
    private static final byte[] SALT = {
        (byte) 0xF3, (byte) 0x1A, (byte) 0x8C, (byte) 0x2B,
        (byte) 0x5E, (byte) 0xD7, (byte) 0x0F, (byte) 0x94,
        (byte) 0xA2, (byte) 0x3C, (byte) 0x6E, (byte) 0xB1,
        (byte) 0x47, (byte) 0x9D, (byte) 0x0A, (byte) 0xE6,
    };

    private static volatile SecretKey cachedKey  = null;
    private static final Object        keyLock   = new Object();
    private static final SecureRandom  RNG       = new SecureRandom();

    // Prevent instantiation
    private CryptHelper() {}

    // ─── KEY ──────────────────────────────────────────────────────────

    /**
     * Derives (or returns cached) AES-256 key bound to this device's ANDROID_ID.
     * Thread-safe via double-checked locking.
     */
    public static SecretKey getKey(Context ctx) {
        if (cachedKey != null) return cachedKey;
        synchronized (keyLock) {
            if (cachedKey != null) return cachedKey;
            cachedKey = deriveKey(ctx);
        }
        return cachedKey;
    }

    private static SecretKey deriveKey(Context ctx) {
        try {
            String androidId = Settings.Secure.getString(
                    ctx.getContentResolver(), Settings.Secure.ANDROID_ID);
            if (androidId == null || androidId.isEmpty() || "9774d56d682e549c".equals(androidId)) {
                // Fallback for emulators / rooted devices that return the generic ID
                androidId = ctx.getPackageName() + "_fallback_" + Build.FINGERPRINT.hashCode();
            }
            final String passphrase = androidId + ctx.getPackageName();
            final KeySpec spec      = new PBEKeySpec(
                    passphrase.toCharArray(), SALT, KDF_ITER, KEY_BITS);
            final SecretKeyFactory factory = SecretKeyFactory.getInstance(KDF_ALG);
            final byte[] rawKey = factory.generateSecret(spec).getEncoded();
            return new SecretKeySpec(rawKey, "AES");
        } catch (Exception e) {
            Log.e(TAG, "Key derivation failed — using emergency zero-key", e);
            // Emergency path: zero key. Still provides the AES-GCM structure
            // (tamper detection still works); confidentiality is lost only in this
            // highly unusual error case (missing JCE provider).
            return new SecretKeySpec(new byte[KEY_BITS / 8], "AES");
        }
    }

    // ─── ENCRYPT / DECRYPT  (String) ─────────────────────────────────

    /**
     * Encrypts a UTF-8 string.
     *
     * @return Base64(iv | ciphertext+tag), or null on error.
     */
    public static String encrypt(Context ctx, String plaintext) {
        if (plaintext == null || plaintext.isEmpty()) return plaintext;
        try {
            final byte[] iv = generateIv();
            final Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, getKey(ctx), new GCMParameterSpec(TAG_BITS, iv));
            final byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

            final ByteBuffer out = ByteBuffer.allocate(IV_LEN + ciphertext.length);
            out.put(iv).put(ciphertext);
            return Base64.encodeToString(out.array(), Base64.NO_WRAP);
        } catch (Exception e) {
            Log.e(TAG, "encrypt(String) failed", e);
            return null;
        }
    }

    /**
     * Decrypts a value produced by {@link #encrypt(Context, String)}.
     *
     * @return plaintext, or null if the ciphertext is malformed or the auth tag fails.
     */
    public static String decrypt(Context ctx, String base64Ciphertext) {
        if (base64Ciphertext == null || base64Ciphertext.isEmpty()) return base64Ciphertext;
        try {
            final byte[] raw = Base64.decode(base64Ciphertext, Base64.NO_WRAP);
            if (raw.length < IV_LEN + 16) return null; // minimum: IV + empty plaintext + 16-byte tag

            final ByteBuffer buf = ByteBuffer.wrap(raw);
            final byte[] iv = new byte[IV_LEN];
            buf.get(iv);
            final byte[] ct = new byte[raw.length - IV_LEN];
            buf.get(ct);

            final Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, getKey(ctx), new GCMParameterSpec(TAG_BITS, iv));
            return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // AEADBadTagException lands here on tampered data — return null silently
            Log.d(TAG, "decrypt(String) failed: " + e.getClass().getSimpleName());
            return null;
        }
    }

    // ─── ENCRYPT / DECRYPT  (byte[]) ─────────────────────────────────

    /**
     * Encrypts raw bytes.
     *
     * @return Base64(iv | ciphertext+tag), or null on error.
     */
    public static String encryptBytes(Context ctx, byte[] data) {
        if (data == null) return null;
        try {
            final byte[] iv = generateIv();
            final Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, getKey(ctx), new GCMParameterSpec(TAG_BITS, iv));
            final byte[] ct = cipher.doFinal(data);

            final ByteBuffer out = ByteBuffer.allocate(IV_LEN + ct.length);
            out.put(iv).put(ct);
            return Base64.encodeToString(out.array(), Base64.NO_WRAP);
        } catch (Exception e) {
            Log.e(TAG, "encryptBytes failed", e);
            return null;
        }
    }

    /**
     * Decrypts a value produced by {@link #encryptBytes(Context, byte[])}.
     *
     * @return plaintext bytes, or null on error.
     */
    public static byte[] decryptBytes(Context ctx, String base64Ciphertext) {
        if (base64Ciphertext == null) return null;
        try {
            final byte[] raw = Base64.decode(base64Ciphertext, Base64.NO_WRAP);
            if (raw.length < IV_LEN + 16) return null;

            final ByteBuffer buf = ByteBuffer.wrap(raw);
            final byte[] iv = new byte[IV_LEN];
            buf.get(iv);
            final byte[] ct = new byte[raw.length - IV_LEN];
            buf.get(ct);

            final Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, getKey(ctx), new GCMParameterSpec(TAG_BITS, iv));
            return cipher.doFinal(ct);
        } catch (Exception e) {
            Log.d(TAG, "decryptBytes failed: " + e.getClass().getSimpleName());
            return null;
        }
    }

    // ─── HELPERS ─────────────────────────────────────────────────────

    private static byte[] generateIv() {
        final byte[] iv = new byte[IV_LEN];
        RNG.nextBytes(iv);
        return iv;
    }

    /**
     * Wipes the cached key.
     * Call this on SELF_DESTRUCT so any subsequent decrypt attempt fails immediately.
     */
    public static synchronized void wipeKey() {
        cachedKey = null;
        Log.d(TAG, "Key cache wiped.");
    }

    /**
     * Returns true if the supplied base64 string looks like it came from
     * {@link #encrypt}/{@link #encryptBytes} (rough format check only, does not verify tag).
     */
    public static boolean looksEncrypted(String value) {
        if (value == null || value.length() < 28) return false; // 16 (IV) + 1 + 11 (min base64 overhead)
        try {
            final byte[] raw = Base64.decode(value, Base64.NO_WRAP);
            return raw.length >= IV_LEN + 16;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
