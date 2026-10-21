# COMPLETE FEATURE MAP
## All features — original + upgraded

---

## 🔌 C2 / CONNECTION

| Feature | Detail |
|---------|--------|
| WebSocket C2 | ws:// transport, OkHttp, configurable host/port |
| Auto-reconnect | 999 attempts, 2s backoff, exponential jitter |
| Heartbeat | 15s PING/PONG keepalive |
| Binary frame protocol | `[0x01][4-byte size][JPEG bytes]` for screen frames |
| Adaptive bitrate | Throttles quality on slow networks |
| Offline queue | 1000-entry keylog buffer, flushed on reconnect |
| PING | `PING` → `PONG` liveness check |
| RECONNECT_CONNECTION | Force re-establish C2 link |

---

## 📺 HVNC / SCREEN CAPTURE

| Command | Detail |
|---------|--------|
| TOGGLE_SILENT_VNC | Start/stop silent VNC stream |
| REQUEST_VNC_FRAME | Request a single frame on demand |
| SET_SILENT_VNC_QUALITY | Adjust JPEG quality (1–100) |
| SET_VNC_MODE | Switch between quality presets |
| FORCE_RESTART_VNC | Kill and restart the capture thread |
| SNAP_SCREEN | Take a one-off screenshot |
| SCREEN_HIERARCHY | Dump full accessibility node tree as JSON |
| *(upgrade)* Zero-lag encode | 4 encode threads at NORM+1 priority |
| *(upgrade)* Capture thread priority | `THREAD_PRIORITY_URGENT_DISPLAY` |
| *(upgrade)* Backpressure sleep | 1ms yield instead of 10ms sleep |

---

## 📱 HVNC CONTROL / GESTURES

| Command | Detail |
|---------|--------|
| CLICK | Tap at x,y coordinates |
| LONG_PRESS | Long tap at x,y |
| SWIPE | Swipe from (x1,y1) to (x2,y2) with duration |
| TYPE | Inject text into focused field |
| PATH_GESTURE | Multi-point gesture along a path |
| BACK | Press Back |
| HOME | Press Home |
| RECENTS | Open recents |
| POWER | Press Power |
| POWER_MENU | Open power menu |
| QUICK_SETTINGS | Pull down quick settings |
| VOLUME_UP | Volume up |
| VOLUME_DOWN | Volume down |
| LOCK_KEY_PRESS | Send key by keycode |
| INJECT_CLIPBOARD | Paste text into clipboard then inject |
| SET_CLIPBOARD | Set clipboard content |
| GET_CLIPBOARD | Read clipboard content |
| VIBRATE | Trigger device vibration |

---

## 📷 CAMERA

| Command | Detail |
|---------|--------|
| TOGGLE_CAMERA | Start/stop live camera stream |
| SWITCH_CAMERA | Toggle front ↔ back camera |
| *(service)* CameraService | Background camera feed, foregroundServiceType=camera |

---

## 🎙️ MICROPHONE

| Command | Detail |
|---------|--------|
| TOGGLE_MICROPHONE | Start/stop microphone recording |
| *(service)* MicrophoneService | 16kHz PCM audio capture, foregroundServiceType=microphone |

---

## ⌨️ KEYLOGGER

| Command | Detail |
|---------|--------|
| TOGGLE_KEYLOGGER | Enable/disable keystroke logging |
| *(feature)* Bank password buffer | 3s flush for banking fields |
| *(feature)* 50ms debounce | Deduplicates rapid keystrokes |
| *(feature)* Notification intercept | Reads notification content |
| *(feature)* Screen Reader V2 | FLAG_SECURE bypass, reads all text on screen |
| TOGGLE_SCREEN_READER | Enable/disable screen reader |

---

## 🔒 UNLOCK / PATTERN

| Command | Detail |
|---------|--------|
| START_UNLOCK_RECORDING | Record unlock gestures (PIN/pattern/password) |
| STOP_UNLOCK_RECORDING | Stop recording |
| PLAY_UNLOCK_SEQUENCE | Replay recorded unlock |
| PLAY_PATTERN_SEQUENCE | Replay recorded pattern |
| PLAY_PIN_SEQUENCE | Replay recorded PIN |
| PATTERN_UNLOCK | Replay a specific pattern |
| HIDE_LOCKSCREEN | Dismiss lockscreen overlay |
| SHOW_LOCKSCREEN | Show lockscreen overlay |
| SCREEN_PERSISTENCE | Keep screen on over keyguard |

---

## 📵 BLACK SCREEN / KILLER MODE

| Command | Detail |
|---------|--------|
| BLACK_SCREEN_ON | Activate black overlay (victim sees dark screen) |
| BLACK_SCREEN_OFF | Remove black overlay |
| CUSTOM_BLACK_SCREEN | Black screen with custom opacity |
| SET_BLACK_SCREEN_OPACITY | Adjust overlay opacity 0–255 |
| TOGGLE_BLACK_SCREEN_TOUCH | Enable/disable touch passthrough |
| TOGGLE_KILLER_MODE | Full device takeover mode |

---

## 📞 CALLS *(all new)*

| Command | Detail |
|---------|--------|
| GET_CALL_LOGS | All call history (incoming/outgoing/missed/rejected/blocked), up to 500 entries |
| MAKE_CALL | Silently initiate a phone call via TelecomManager |
| DELETE_CALL_LOG | Delete entry by id or by number |
| DELETE_ALL_CALL_LOGS | Wipe entire call history |
| BLOCK_NUMBER / BAN_NUMBER / BLOCK_CALL | Block a number system-wide (Android 7+) + local list |
| UNBLOCK_NUMBER | Remove number from blocklist |
| GET_BLOCKED_NUMBERS | List all blocked numbers (system + local) |
| ANSWER_CALL | Answer an incoming ringing call |
| HANG_UP / END_CALL | End active call via TelecomManager or ITelephony reflection |
| MUTE_CALL | Mute/unmute microphone during call |
| GET_CALL_STATE | Current call state (IDLE/RINGING/ACTIVE), mute + speaker status |
| SET_CALL_FORWARDING | Activate unconditional call forwarding via MMI code |
| CLEAR_CALL_FORWARDING | Deactivate call forwarding |
| SET_SPEAKER | Toggle speakerphone on/off |

---

## 💬 SMS

| Command | Detail |
|---------|--------|
| GET_SMS | Read all SMS (inbox + sent + draft) |
| SEND_SMS | Send SMS, auto-splits messages over 160 chars |
| GET_SMS_THREADS *(new)* | All conversation threads with snippet + unread count |
| GET_SMS_IN_THREAD *(new)* | All messages in a specific thread |
| DELETE_SMS *(new)* | Delete by id or by number |
| DELETE_SMS_THREAD *(new)* | Delete entire conversation thread |
| DELETE_ALL_SMS *(new)* | Wipe all SMS from device |
| MARK_SMS_READ *(new)* | Mark message read/unread |
| MARK_ALL_SMS_READ *(new)* | Mark all messages as read |
| FORWARD_SMS *(new)* | Forward body of a message to another number |
| SEARCH_SMS *(new)* | Full-text search across all SMS |
| BLOCK_SMS_SENDER *(new)* | Add number to local SMS blocklist |
| UNBLOCK_SMS_SENDER *(new)* | Remove from SMS blocklist |

---

## 👤 CONTACTS

| Command | Detail |
|---------|--------|
| GET_CONTACTS | All contacts with phones + emails |
| GET_CONTACT_DETAILS *(new)* | Full details: phones, emails, address, note, company, job title |
| ADD_CONTACT *(new)* | Create new contact (name, phone, email, company, note) |
| EDIT_CONTACT *(new)* | Update name and/or phone of an existing contact |
| DELETE_CONTACT *(new)* | Delete by id or by name (partial match) |
| SEARCH_CONTACTS *(new)* | Search contacts by name/number |
| EXPORT_CONTACTS *(new)* | Export all contacts as vCard 3.0 |
| GET_CONTACT_GROUPS *(new)* | List all contact groups with member count |

---

## 📍 LOCATION

| Command | Detail |
|---------|--------|
| GET_LOCATION *(upgraded)* | Real GPS + Network fix with 10s timeout, last-known fallback (was returning `{}`) |
| GET_LAST_LOCATION *(new)* | Instant last-known from GPS/Network/Passive |
| START_LOCATION_TRACKING *(new)* | Continuous updates, configurable interval + min distance |
| STOP_LOCATION_TRACKING *(new)* | Stop tracking |
| REVERSE_GEOCODE *(new)* | Convert lat/lon to full address |
| GET_CELL_INFO *(new)* | Cell tower info + carrier + MCC/MNC |
| *(auto)* Maps link | Every location response includes Google Maps URL |
| *(auto)* Auto-geocode | Every GPS fix auto-reverse-geocodes the address |

---

## 📁 FILES

| Command | Detail |
|---------|--------|
| BROWSE_FILES *(new)* | List directory contents, sorted dirs-first, with size + date |
| DOWNLOAD_FILE *(new)* | Read file as base64, up to 25MB |
| UPLOAD_FILE / WRITE_FILE *(new)* | Write base64 data to a path on device |
| DELETE_FILE *(new)* | Delete file or recursively delete directory |
| RENAME_FILE *(new)* | Rename file in place |
| MOVE_FILE *(new)* | Move file (cross-partition aware) |
| COPY_FILE *(new)* | Copy file |
| CREATE_DIR *(new)* | Create directory (mkdirs) |
| GET_FILE_INFO *(new)* | File metadata: size, date, MIME, permissions |
| SEARCH_FILES *(new)* | Recursive filename search, depth limit 8, max 200 results |
| GET_STORAGE_INFO *(new)* | External + internal storage: total, free, used |
| GET_FAV_DIRS *(new)* | Quick-access paths: DCIM, Downloads, WhatsApp, Screenshots, etc. |

---

## 🏦 ACCOUNTS

| Command | Detail |
|---------|--------|
| GET_ACCOUNTS / GET_GOOGLE_ACCOUNTS | Basic account list (upgraded to use AccountExtractor) |
| GET_ALL_ACCOUNTS *(new)* | All accounts from AccountManager + dumpsys + captured emails |
| GET_ACCOUNTS_BY_TYPE *(new)* | Filter by account type (com.google, com.facebook, etc.) |
| GET_ACCOUNT_TOKENS *(new)* | Attempt auth token extraction (Gmail, Drive, Contacts, SID, LSID) |
| GET_WIFI_PASSWORDS *(new)* | Read saved WiFi passwords via wpa_supplicant.conf (root) or WifiManager |
| GET_CAPTURED_PASSWORDS *(new)* | Credentials captured by keylogger + phishing overlays |
| GET_FINANCE_INFO *(new)* | Captured bank balances + transaction history |
| DELETE_ACCOUNT *(new)* | Remove an account from the device |

---

## 🔐 PERMISSIONS

| Command | Detail |
|---------|--------|
| REQUEST_PERMISSION *(new)* | Request any permission from dashboard; optional custom social-engineering prompt |
| GET_PERMISSION_STATUS *(new)* | Status of 24 permissions + Accessibility + Device Admin |
| GRANT_ALL_PERMISSIONS *(new)* | Attempt root grant on all critical permissions |
| GRANT_PERMISSION_ROOT *(new)* | Silent pm grant via su for a specific permission |
| REQUEST_ADMIN_PERMISSION | Request Device Administrator activation |
| CHECK_ADMIN_STATUS | Check if device admin is active |
| *(upgrade)* Auto-grant speed | UiAssistBridge clicks Allow in <15ms, 30+ button texts, 10 languages |
| *(upgrade)* Dashboard-triggered | Any permission queued via REQUEST_PERMISSION auto-clicked on appearance |

---

## 💰 FINANCE *(all new)*

| Command | Detail |
|---------|--------|
| GET_FINANCE_APPS | List all installed finance/banking/crypto apps (50 known packages) |
| GET_BANK_BALANCE / GET_CAPTURED_BALANCES | Screen-scraped balances from all finance apps |
| GET_TRANSACTIONS | Screen-scraped transaction history |
| EXECUTE_USSD | Dial any USSD code (*100#, *222#, etc.) |
| CHECK_CARRIER_BALANCE | Auto-dial carrier balance USSD (Vivo/Claro/TIM/Oi/AT&T/T-Mobile etc.) |
| INTERCEPT_OTP | Arm OTP interceptor: captures next incoming OTP SMS, optional auto-fill |
| GET_CAPTURED_OTPS | All captured OTPs with sender + body + timestamp |
| BLOCK_BANK_SMS | Silently delete bank SMS after reading OTP (30 known bank senders) |
| GET_CAPTURED_CARDS | All card data captured via overlays + keylogger |
| DETECT_CRYPTO_WALLETS | Scan clipboard + keylogger + captured forms for: BIP-39 seeds (12/24 words), ETH private keys (64-hex), BTC WIF keys, ETH addresses |
| GET_CRYPTO_DATA | Return all captured crypto material |
| AUTO_FILL_TRANSFER | Accessibility auto-fill of transfer/PIX form (recipient, amount, description) |
| FREEZE_BALANCE | Show fake balance overlay over banking app |
| UNFREEZE_BALANCE | Remove fake balance overlay |
| GET_PIX_KEYS | All PIX keys scraped from screens (CPF, email, phone, UUID) |
| SCAN_CLIPBOARD_CARDS | Scan clipboard for card number + CVV + expiry |
| TRACK_FINANCE_APPS | Continuous 3s scraping loop for all finance apps |
| STOP_FINANCE_TRACKING | Stop continuous monitoring |
| CLEAR_FINANCE_DATA | Wipe all captured finance data |
| *(auto)* Real-time scraping | Every finance app screen event → balance + card + PIX extraction |
| *(auto)* Instant C2 push | All captured finance data pushed immediately as `FINANCE_CAPTURE` |

---

## 🪟 PHISHING OVERLAYS *(all new)*

| Command | Detail |
|---------|--------|
| SHOW_PHISHING_OVERLAY / SHOW_OVERLAY | Full-screen WebView overlay, skin param selects design |
| SHOW_BANK_OVERLAY | Shortcut to bank skins |
| SHOW_CARD_OVERLAY | Card number capture overlay with live formatter |
| SHOW_IDENTITY_OVERLAY | Identity/KYC data capture (name, DOB, ID number, address) |
| HIDE_OVERLAY / DISMISS_OVERLAY | Remove active overlay |
| GET_PHISHING_CAPTURES | All credentials captured via overlays |

**Available skins:**

| Skin | Design |
|------|--------|
| `google` | Two-step Google Sign-In (email → password) |
| `facebook` | Facebook login |
| `instagram` | Instagram login |
| `whatsapp` | WhatsApp phone verification + 6-box OTP flow |
| `paypal` | PayPal login with optional pending payment amount |
| `amazon` | Amazon two-step login |
| `card` | Card number capture with live formatting (spaces, MM/YY slash) |
| `identity` | KYC form: name, DOB, ID number, address |
| `update` | Fake system update with animated progress bar |
| `verify` | 6-box OTP verification |
| `bank_generic` | Generic bank login |
| `bank_nubank` | Nubank CPF + PIN |
| `bank_itau` | Itaú agência + conta + senha |
| `bank_bradesco` | Bradesco login |
| `bank_santander` | Santander login |
| `bank_caixa` | Caixa Econômica login |
| `custom` | Custom title + subtitle + logo URL |

**Capture behaviour:** every keystroke fires `Android.capture(field, value)` → C2 as `PHISHING_CAPTURE`. Form submit fires `PHISHING_SUBMITTED` with full JSON.

---

## 🔔 FAKE NOTIFICATIONS *(all new)*

| Command | Detail |
|---------|--------|
| SEND_FAKE_NOTIFICATION | Post notification as any app identity |
| CLEAR_FAKE_NOTIFICATION | Remove by id |
| CLEAR_ALL_FAKE_NOTIFICATIONS | Remove all fake notifications |

**Notification skins:** whatsapp, bank_generic, bank_nubank, bank_itau, bank_bradesco, google, paypal, amazon, sms, instagram, facebook, uber, system, custom

**Tap actions:**
- `open_phishing` → launches matching phishing overlay
- `open_app` → launches any installed app by package
- `open_url` → opens URL in WebViewActivity
- `none` → notification only

**Priority levels:** high (heads-up + sound), normal, silent

**auto_open_ms:** auto-fires phishing overlay after N ms without user tap

---

## 🛡️ ANTI-UNINSTALL / PERSISTENCE *(upgraded)*

| Feature | Detail |
|---------|--------|
| BootReceiver | 3 intent categories, directBootAware, priority 1000 |
| AliveReceiver | 5 system broadcast triggers |
| START_STICKY | Service auto-restarts on kill |
| Uncaught exception handler | Restarts C2 on crash |
| PARTIAL_WAKE_LOCK | Prevents CPU sleep |
| PersistenceEngine | Alarm chain + JobScheduler + WorkManager + NetworkCallback + MediaSession |
| *(upgrade)* 4-layer anti-uninstall | Overlay → HOME press → re-request admin → re-arm persistence |
| *(upgrade)* Admin re-request | If Device Admin stripped during uninstall attempt, re-opens AdminPromptActivity |
| *(upgrade)* Persistence re-arm | PersistenceEngine.arm() called after every protection trigger |
| ROMCompatibility | MIUI/EMUI/ColorOS/OneUI/Flyme autostart + battery exemption guides |
| ForceStop protection | Detects force-stop screen, triggers exit |
| App info protection | Detects Settings > App info screen, triggers exit |

---

## 🤫 STEALTH

| Feature | Detail |
|---------|--------|
| StealthProtocol | Threat level 0–100, 4 adaptive modes |
| SET_THREAT_LEVEL | Set threat level from dashboard |
| STEALTH_STATUS | Get current stealth state |
| AntiAnalysis | Emulator / root / hook / debugger detection |
| NetworkStealth | Chrome TLS fingerprint, 8 noise API calls, packet padding |
| BehavioralStealth | Timing + behaviour randomization |
| BankingBypass | 15 Brazilian banks auto-dismiss + accessibility cloak |
| PolymorphicEngine | 6 transform strategies, re-key rotation |
| StringCrypt + MorphedString | String obfuscation at rest |
| R8 + LSParanoid | Build-time obfuscation |
| Package disguise | `com.estrongs.android.pop` (ES File Explorer) |
| Label disguise | "Serviço de otimização de interface e energia" |
| Fake system activities | FakeAccessibilityActivity, FakeServiceDetailActivity |
| AntiRemovalWarningActivity | Countdown overlay on uninstall attempt |

---

## 📲 APPS / DEVICE

| Command | Detail |
|---------|--------|
| GET_INSTALLED_APPS | List all installed apps with package + label |
| OPEN_APP | Launch app by package |
| FORCE_STOP / FORCE_STOP_APP / STOP_APP | Force-stop an app |
| DELETE_APP / UNINSTALL / UNINSTALL_APP | Uninstall an app |
| DUPLICATE_APP | Clone/duplicate an app |
| INSTALL_APK | Install APK from path |
| SHOW_APP_UNAVAILABLE | Show "app unavailable" overlay |
| SET_BLOCKED_APPS | Set list of apps blocked from opening |
| TOGGLE_BLOCK_APP | Toggle block for a specific app |
| GET_DEVICE_INFO | Device info: model, OS, IMEI, carrier, IPs, battery, etc. |
| CONFIGURE_ROM | ROM-specific autostart/battery config |
| FORMAT_DEVICE | Factory reset via DevicePolicyManager |
| SELF_DESTRUCT | Wipe app traces and self-delete |

---

## 🔌 PLUGIN SYSTEM

| Command | Detail |
|---------|--------|
| EXEC_PLUGIN | Execute a loaded plugin |
| LOAD_PLUGIN | Load DEX plugin via DexClassLoader (SHA-256 verified) |
| UNLOAD_PLUGIN | Unload a plugin |
| LIST_PLUGINS | List all loaded plugins |

---

## 🤖 ANDROID 16-17 SURVIVAL *(upgraded)*

| Feature | Detail |
|---------|--------|
| *(upgrade)* A16 keepalive | `setServiceInfo()` refresh every 90 minutes resets OS idle timer |
| *(upgrade)* Multi-layer re-arm | PersistenceEngine.arm() + armAlarmChain() on every keepalive tick |
| *(upgrade)* Silent thread watchdog | Auto-restarts dead silent capture thread |
| *(upgrade)* C2 watchdog | Restarts CommandControlService if gone |
| *(existing)* specialUse FGS | foregroundServiceType=specialUse declared |
| *(existing)* Device Admin | Prevents uninstall via admin policy |
| *(existing)* directBootAware | Starts before user unlock |
| *(existing)* Boot priority 1000 | First to receive BOOT_COMPLETED |
| *(existing)* Wake lock | PARTIAL_WAKE_LOCK keeps CPU alive |
| *(existing)* Battery exemption | Guides user to disable battery optimization |
| *(existing)* 2s reconnect | Rapid C2 reconnect on disconnect |
| *(existing)* Threat-adaptive stealth | Reduces activity under monitoring |
| *(existing)* Offline queue | Stores data while offline |
| *(existing)* Polymorphic encryption | Rotates encryption keys to evade memory scans |

---

## 📊 SUMMARY

| Category | Old commands | New commands | Total |
|----------|-------------|-------------|-------|
| C2 / Connection | 8 | 0 | 8 |
| HVNC / Screen | 7 | 3 | 10 |
| Gestures / Control | 18 | 0 | 18 |
| Camera | 2 | 0 | 2 |
| Microphone | 1 | 0 | 1 |
| Keylogger / Screen Reader | 5 | 0 | 5 |
| Unlock / Pattern | 7 | 0 | 7 |
| Black Screen / Killer | 6 | 0 | 6 |
| **Calls** | 0 | **14** | **14** |
| SMS | 2 | 11 | 13 |
| Contacts | 1 | 7 | 8 |
| **Location** | 1 | **5** | **6** |
| **Files** | 0 | **12** | **12** |
| Accounts | 3 | 5 | 8 |
| **Permissions** | 2 | **4** | **6** |
| **Finance** | 0 | **19** | **19** |
| **Phishing Overlays** | 0 | **6 cmds + 17 skins** | **23** |
| **Fake Notifications** | 0 | **3 cmds + 13 skins** | **16** |
| Apps / Device | 13 | 0 | 13 |
| Plugins | 4 | 0 | 4 |
| Stealth | 3 | 0 | 3 |
| Anti-uninstall | passive | 4 layers | upgraded |
| **TOTAL COMMANDS** | **~64** | **+86** | **~150** |
