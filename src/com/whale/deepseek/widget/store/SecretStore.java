package com.whale.deepseek.widget.store;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 凭证加密存储：Android Keystore 生成AES-256密钥，AES/GCM 加密后落盘 SharedPreferences。
 * 不使用明文存储任何 API Key。
 */
public class SecretStore {

    private static final String TAG = "SecretStore";
    private static final String KS_NAME = "AndroidKeyStore";
    private static final String ALIAS = "whale_master_key";
    private static final String PREFS_NAME = "whale_secrets";
    private static final int GCM_TAG_BITS = 128;

    private static SecretKey getOrCreateKey() {
        try {
            KeyStore ks = KeyStore.getInstance(KS_NAME);
            ks.load(null);
            if (ks.containsAlias(ALIAS)) {
                return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
            }
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KS_NAME);
            kg.init(new KeyGenParameterSpec.Builder(ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return kg.generateKey();
        } catch (Exception e) {
            Log.e(TAG, "Keystore key error", e);
            return null;
        }
    }

    /** 加密保存 */
    public static void save(Context ctx, String field, String plain) {
        if (plain == null || plain.isEmpty()) {
            delete(ctx, field);
            return;
        }
        try {
            SecretKey key = getOrCreateKey();
            if (key == null) return;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(plain.getBytes("UTF-8"));
            String enc = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
            prefs(ctx).edit().putString(field, enc).apply();
        } catch (Exception e) {
            Log.e(TAG, "save error", e);
        }
    }

    /** 解密读取，失败返回 null */
    public static String load(Context ctx, String field) {
        String enc = prefs(ctx).getString(field, null);
        if (enc == null || !enc.contains(":")) return null;
        try {
            String[] parts = enc.split(":", 2);
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ct = Base64.decode(parts[1], Base64.NO_WRAP);
            SecretKey key = getOrCreateKey();
            if (key == null) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] pt = cipher.doFinal(ct);
            return new String(pt, "UTF-8");
        } catch (Exception e) {
            Log.e(TAG, "load error", e);
            return null;
        }
    }

    public static void delete(Context ctx, String field) {
        prefs(ctx).edit().remove(field).apply();
    }

    public static boolean has(Context ctx, String field) {
        return prefs(ctx).contains(field);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}