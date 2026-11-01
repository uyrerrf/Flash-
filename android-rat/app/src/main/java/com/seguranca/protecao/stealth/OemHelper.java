package com.seguranca.protecao.stealth;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

/**
 * OemHelper — direct ComponentName targets for every major OEM's
 * background-kill and battery-restriction settings screens.
 *
 * MIUI/HyperOS, Samsung One UI, Huawei/Honor EMUI, Oppo/Realme/OnePlus
 * ColorOS, Vivo FuntouchOS, Infinix/Tecno/Itel PhoneMaster all ship
 * proprietary kill-switches that bypass AlarmManager, JobScheduler,
 * and every standard Android persistence layer. This class opens each
 * OEM's exact screen so setup can acquire the exemptions at first run.
 *
 * Call openAutoStartSettings() and openBatterySettings() from
 * SetupWizardActivity during the permission grant flow.
 */
public final class OemHelper {

    private static final String TAG = "OemHelper";

    private OemHelper() {}

    // ── Manufacturer detection ─────────────────────────────────────────────────

    public static String getManufacturer() {
        return Build.MANUFACTURER.toLowerCase();
    }

    public static boolean isXiaomi() {
        String m = getManufacturer();
        return m.contains("xiaomi") || m.contains("redmi") || m.contains("poco");
    }

    public static boolean isSamsung() {
        return getManufacturer().contains("samsung");
    }

    public static boolean isHuawei() {
        String m = getManufacturer();
        return m.contains("huawei") || m.contains("honor");
    }

    public static boolean isOppo() {
        String m = getManufacturer();
        return m.contains("oppo") || m.contains("realme") || m.contains("oneplus");
    }

    public static boolean isVivo() {
        return getManufacturer().contains("vivo");
    }

    public static boolean isInfinix() {
        String m = getManufacturer();
        return m.contains("infinix") || m.contains("tecno") || m.contains("itel");
    }

    public static boolean isMotorola() {
        return getManufacturer().contains("motorola") || getManufacturer().contains("lenovo");
    }

    // ── Autostart settings ─────────────────────────────────────────────────────

    /**
     * Opens the OEM-specific autostart management screen directly.
     * Falls back to app details if the OEM screen is unavailable.
     */
    public static void openAutoStartSettings(Context ctx) {
        try {
            Intent i = buildAutoStartIntent(ctx);
            if (i != null) {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                Log.d(TAG, "Opened autostart settings for: " + getBrandName());
            } else {
                openAppDetails(ctx);
            }
        } catch (Exception e) {
            Log.w(TAG, "openAutoStartSettings failed: " + e.getMessage());
            openAppDetails(ctx);
        }
    }

    private static Intent buildAutoStartIntent(Context ctx) {
        if (isXiaomi()) {
            // HyperOS (Android 14+) moved to security center v2; try both
            Intent i = tryComponent(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity");
            if (i != null) return i;
            return tryComponent(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity");
        }
        if (isSamsung()) {
            // One UI 6+ (Android 14/15/16) uses sm.battery package
            Intent i = tryComponent(
                "com.samsung.android.sm.battery",
                "com.samsung.android.sm.battery.app.ui.BatteryActivity");
            if (i != null) return i;
            // One UI 4/5 fallback
            return tryComponent(
                "com.samsung.android.sm",
                "com.samsung.android.sm.app.dashboard.SmartManagerDashBoardActivity");
        }
        if (isHuawei()) {
            return tryComponent(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity");
        }
        if (isOppo()) {
            // ColorOS 14+ (Android 14/15/16) updated package
            Intent i = tryComponent(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.startup.StartupAppListActivity");
            if (i != null) return i;
            return tryComponent(
                "com.oplus.safecenter",
                "com.oplus.safecenter.permission.startup.StartupAppListActivity");
        }
        if (isVivo()) {
            return tryComponent(
                "com.vivo.permissionmanager",
                "com.vivo.permissionmanager.activity.BgStartUpManagerActivity");
        }
        if (isInfinix()) {
            return tryComponent(
                "com.transsion.phonemaster",
                "com.cyin.himgr.autostart.AutoStartActivity");
        }
        // Motorola and stock Android have no proprietary autostart screen
        return null;
    }

    // ── Battery restriction settings ────────────────────────────────────────────

    /**
     * Opens the OEM-specific battery optimisation / unrestricted-background
     * screen directly. Falls back to the standard system battery screen.
     */
    public static void openBatterySettings(Context ctx) {
        try {
            Intent i = buildBatteryIntent(ctx);
            if (i != null) {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                Log.d(TAG, "Opened battery settings for: " + getBrandName());
            } else {
                openStandardBatteryOptimization(ctx);
            }
        } catch (Exception e) {
            Log.w(TAG, "openBatterySettings failed: " + e.getMessage());
            openAppDetails(ctx);
        }
    }

    private static Intent buildBatteryIntent(Context ctx) {
        if (isXiaomi()) {
            Intent i = tryComponent(
                "com.miui.powerkeeper",
                "com.miui.powerkeeper.ui.HiddenAppsConfigActivity");
            if (i != null) {
                i.putExtra("package_name", ctx.getPackageName());
                i.putExtra("package_label", "System Service");
            }
            return i;
        }
        if (isSamsung()) {
            // One UI 6+ (Android 14/15/16)
            Intent i = tryComponent(
                "com.samsung.android.sm.battery",
                "com.samsung.android.sm.battery.app.ui.BatteryActivity");
            if (i != null) return i;
            // One UI 4/5 fallback
            return tryComponent(
                "com.samsung.android.lool",
                "com.samsung.android.sm.ui.battery.BatteryActivity");
        }
        if (isHuawei()) {
            return tryComponent(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.optimize.process.ProtectActivity");
        }
        if (isOppo()) {
            Intent i = tryComponent(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.PermissionManagerActivity");
            if (i != null) return i;
            return tryComponent(
                "com.oplus.safecenter",
                "com.oplus.safecenter.permission.PermissionManagerActivity");
        }
        if (isVivo()) {
            return tryComponent(
                "com.vivo.permissionmanager",
                "com.vivo.permissionmanager.activity.PurviewTabActivity");
        }
        if (isInfinix()) {
            return tryComponent(
                "com.transsion.phonemaster",
                "com.cyin.himgr.battprot.BattProtActivity");
        }
        // Motorola / stock — go straight to standard system screen
        return null;
    }

    // ── Standard system battery optimization (API 23+) ─────────────────────────

    private static void openStandardBatteryOptimization(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent std = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                std.setData(Uri.parse("package:" + ctx.getPackageName()));
                std.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(std);
            } else {
                openAppDetails(ctx);
            }
        } catch (Exception e) {
            Log.w(TAG, "openStandardBatteryOptimization failed: " + e.getMessage());
            openAppDetails(ctx);
        }
    }

    // ── Fallback ───────────────────────────────────────────────────────────────

    public static void openAppDetails(Context ctx) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) {}
    }

    // ── Intent build helper ────────────────────────────────────────────────────

    /**
     * Builds a ComponentName Intent and returns it, or returns null if the
     * component is known not to exist (so callers can try the next candidate).
     * Does NOT start the activity — callers add flags and start it.
     */
    private static Intent tryComponent(String pkg, String cls) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(pkg, cls));
        return i;
    }

    // ── Info helpers ────────────────────────────────────────────────────────────

    public static String getBrandName() {
        if (isXiaomi())    return "Xiaomi / MIUI / HyperOS";
        if (isSamsung())   return "Samsung One UI";
        if (isHuawei())    return "Huawei / Honor EMUI";
        if (isOppo())      return "Oppo / Realme / OnePlus ColorOS";
        if (isVivo())      return "Vivo FuntouchOS";
        if (isInfinix())   return "Infinix / Tecno / Itel";
        if (isMotorola())  return "Motorola / Lenovo";
        return "Android " + Build.VERSION.RELEASE + " (" + Build.MANUFACTURER + ")";
    }

    /**
     * Returns OEM-specific instructions to show to the user during
     * the setup flow so they know exactly what to enable.
     */
    public static String getSetupHint() {
        if (isXiaomi())
            return "Xiaomi / MIUI / HyperOS:\n"
                 + "1. Security → Permissions → Autostart → Enable this app\n"
                 + "2. Security → Battery → No restrictions\n"
                 + "3. Settings → Additional settings → Developer options → MIUI Optimization → OFF";
        if (isSamsung())
            return "Samsung One UI:\n"
                 + "1. Settings → Device care → Battery → Background usage limits\n"
                 + "2. Never sleeping apps → Add this app\n"
                 + "3. Settings → Apps → this app → Battery → Unrestricted";
        if (isHuawei())
            return "Huawei / Honor EMUI:\n"
                 + "1. Phone Manager → App launch → this app → Manage manually\n"
                 + "2. Enable: Auto-launch, Secondary launch, Run in background\n"
                 + "3. Battery → Protected apps → Add this app";
        if (isOppo())
            return "Oppo / Realme / OnePlus:\n"
                 + "1. Settings → Battery → Battery optimization → this app → Don't optimize\n"
                 + "2. Security Center → Privacy permissions → Startup manager → Allow";
        if (isVivo())
            return "Vivo:\n"
                 + "1. Settings → Battery → High background power consumption → Allow\n"
                 + "2. iManager → Autostart Manager → Enable this app";
        if (isInfinix())
            return "Infinix / Tecno:\n"
                 + "1. Phone Master → Auto-start Manager → Enable this app\n"
                 + "2. Battery → App management → No restrictions";
        if (isMotorola())
            return "Motorola:\n"
                 + "1. Settings → Apps → this app → Battery → Unrestricted\n"
                 + "2. Settings → Battery → Battery optimization → this app → Don't optimize";
        return "Settings → Apps → this app → Battery → Unrestricted";
    }
}
