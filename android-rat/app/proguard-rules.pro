# ==================== R8 DEFENSIVO E OTIMIZADO (release) ====================
# Redução máxima de MB e eliminação completa de Logs

-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
-allowaccessmodification
-optimizationpasses 5
-repackageclasses ''
-dontusemixedcaseclassnames

# ==================== REMOÇÃO TOTAL DE LOGS ====================
# Remove todas as chamadas android.util.Log e System.out/err no APK compilado
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
    public static *** println(...);
    public static *** getStackTraceString(...);
}

-assumenosideeffects class java.io.PrintStream {
    public *** print(...);
    public *** println(...);
}

# LSParanoid string encryption runtime
-keep class org.lsposed.lsparanoid.** { *; }

# Manifest entry points
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Application

# Accessibility framework callbacks
-keep public class * extends android.accessibilityservice.AccessibilityService {
    protected void onServiceConnected();
    public void onAccessibilityEvent(android.view.accessibility.AccessibilityEvent);
    public void onInterrupt();
}

# Accessibility shell (broadcast Intent strings — no @Obfuscate)
-keepnames class com.seguranca.protecao.UiAssistBridge

# Component id helper (Settings API)
-keep class com.seguranca.protecao.AppComponents { *; }

# Gson / OkHttp
-keep class com.google.gson.** { *; }
-keep class okhttp3.** { *; }
-dontwarn okhttp3.**

# Room (dependency present)
-keep class * extends androidx.room.RoomDatabase { *; }
-keep @androidx.room.Entity class *

# ViewBinding
-keep class * implements androidx.viewbinding.ViewBinding {
    public static ** bind(android.view.View);
    public static ** inflate(...);
}

# Suppress noise
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**

