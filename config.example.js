module.exports = {
    // Jellyfin server URL (e.g., http://192.168.1.100:8096)
    serverUrl: '',
    
    // Your Jellyfin username
    username: '',
    
    // Your Jellyfin password
    password: '',
    
    // Full path to MPV executable
    // macOS:   '/opt/homebrew/bin/mpv' (Apple Silicon) or '/usr/local/bin/mpv' (Intel)
    // Linux:   '/usr/bin/mpv' (or just 'mpv' if in PATH)
    // Windows: 'C:\\Program Files\\mpv\\mpv.exe' (or just 'mpv' if in PATH)
    mpvPath: 'mpv',
    
    // Device name (will appear in Jellyfin's device list)
    deviceName: 'Jellyfin MPV Play',
    
    // Any name, but different from the one you put in deviceName
    deviceId: 'jellyfin-mpv-play',
    
    // IPC socket path (optional — defaults to $XDG_RUNTIME_DIR/mpv-ipc.sock on Linux, /tmp/mpv-ipc.sock on macOS, \\.\pipe\mpv-ipc on Windows)
    // ipcSocketPath: '/tmp/mpv-ipc.sock'

    // Multi-config support: create multiple config files (e.g., config.work.js, config.personal.js)
    // and run with: node shim.js config.work.js
    // Each config gets its own deviceId, token, positions, and IPC socket.
    //
    // To run multiple instances of the same config:
    //   node shim.js config.js --allow-duplicates
    //   ./launch.sh config.js --allow-duplicates
    // Without --allow-duplicates, a dialog warns about duplicates (headless mode).
    // With --allow-duplicates, the dialog is skipped.
    // Log files: shim-config.log (single instance), shim-config-<PID>.log (headless with --allow-duplicates)

    // Start MPV in fullscreen (optional — default: false)
    // fullscreen: true,

    // Close the app when playback finishes (optional — default: false)
    // autoClose: true,

    // Extra MPV flags (optional — array of strings passed to MPV)
    // mpvFlags: ['--hwdec=auto', '--vo=gpu-next'],

    // Headless mode — suppress console output, log to data/shim-<configname>.log (optional — default: false)
    // Useful for running as a background service on Linux/Windows
    // headless: true,

    // Auto-skip intros and outros (optional — default: false)
    // true = auto-skip after 3s, false = show "Press S to skip" OSD
    // autoSkipIntros: true,

    // Completely disable intro/outro skip feature (optional — default: false)
    // Hides skip prompts and does not bind the S key
    // disableSkipIntro: true,

    // Verbose logging (optional — default: false)
    // Show debug-level logs with timestamps and component names
    // verbose: true,

    // Redundant presence WebSocket (optional — default: true)
    // Keeps a second connection to the server so the session stays listed in
    // /Sessions through a single-socket drop — the Jellyfin web UI otherwise
    // drops its cast selection and playback controls. Set false for a single
    // connection (you lose the drop protection).
    // wsPresenceSocket: false,
};