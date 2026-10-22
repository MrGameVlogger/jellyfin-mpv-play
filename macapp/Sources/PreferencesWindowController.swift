import Cocoa
import ServiceManagement

class PreferencesWindowController: NSWindowController {
    private var configFilePopup: NSPopUpButton!
    private var serverUrlField: NSTextField!
    private var usernameField: NSTextField!
    private var passwordField: NSSecureTextField!
    private var apiKeyField: NSSecureTextField!
    private var mpvPathField: NSTextField!
    private var deviceNameField: NSTextField!
    private var deviceIdField: NSTextField!
    private var ipcSocketPathField: NSTextField!
    private var mpvFlagsField: NSTextField!
    private var fullscreenCheckbox: NSButton!
    private var autoCloseCheckbox: NSButton!
    private var headlessCheckbox: NSButton!
    private var skipAutoRadio: NSButton!
    private var skipPromptRadio: NSButton!
    private var skipDisableRadio: NSButton!
    private var verboseCheckbox: NSButton!
    private var testButton: NSButton!
    private var statusLabel: NSTextField!
    private var launchAtLoginCheckbox: NSButton!
    var onSave: (() -> Void)?

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 740),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Settings"
        window.center()
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        self.init(window: window)
        setupUI()
        populateConfigFiles()
        loadConfig()
    }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        // Reload on every show so Cancel is a true cancel: edits and config
        // selection changes made since the last save are discarded.
        populateConfigFiles()
        loadConfig()
        window?.makeFirstResponder(serverUrlField)
    }

    private func setupUI() {
        guard let contentView = window?.contentView else { return }

        var yOffset: CGFloat = 700

        // MARK: - Config File Section
        let configLabel = sectionLabel("Config File")
        configLabel.frame = NSRect(x: 20, y: yOffset, width: 520, height: 20)
        contentView.addSubview(configLabel)
        yOffset -= 28

        let configFileLabel = NSTextField(labelWithString: "Active config:")
        configFileLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        configFileLabel.alignment = .right
        contentView.addSubview(configFileLabel)

        configFilePopup = NSPopUpButton()
        configFilePopup.frame = NSRect(x: 130, y: yOffset, width: 300, height: 24)
        configFilePopup.target = self
        configFilePopup.action = #selector(configFileChanged)
        contentView.addSubview(configFilePopup)

        let refreshButton = NSButton(title: "Refresh", target: self, action: #selector(refreshConfigFiles))
        refreshButton.frame = NSRect(x: 440, y: yOffset, width: 70, height: 24)
        contentView.addSubview(refreshButton)
        yOffset -= 30

        // Separator
        let separator0 = NSBox()
        separator0.boxType = .separator
        separator0.frame = NSRect(x: 20, y: yOffset, width: 540, height: 1)
        contentView.addSubview(separator0)
        yOffset -= 20

        // MARK: - Connection Section
        let connectionLabel = sectionLabel("Connection")
        connectionLabel.frame = NSRect(x: 20, y: yOffset, width: 520, height: 20)
        contentView.addSubview(connectionLabel)
        yOffset -= 30

        // Server URL
        let serverLabel = NSTextField(labelWithString: "Server URL:")
        serverLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        serverLabel.alignment = .right
        contentView.addSubview(serverLabel)

        serverUrlField = NSTextField()
        serverUrlField.frame = NSRect(x: 130, y: yOffset, width: 410, height: 24)
        serverUrlField.setAccessibilityLabel("Server URL")
        contentView.addSubview(serverUrlField)
        yOffset -= 36

        // Username
        let userLabel = NSTextField(labelWithString: "Username:")
        userLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        userLabel.alignment = .right
        contentView.addSubview(userLabel)

        usernameField = NSTextField()
        usernameField.frame = NSRect(x: 130, y: yOffset, width: 410, height: 24)
        usernameField.setAccessibilityLabel("Username")
        contentView.addSubview(usernameField)
        yOffset -= 36

        // Password
        let passLabel = NSTextField(labelWithString: "Password:")
        passLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        passLabel.alignment = .right
        contentView.addSubview(passLabel)

        passwordField = NSSecureTextField()
        passwordField.frame = NSRect(x: 130, y: yOffset, width: 410, height: 24)
        passwordField.setAccessibilityLabel("Password")
        contentView.addSubview(passwordField)
        yOffset -= 36

        // API Key (optional) — credential for the media URLs handed to MPV
        let apiKeyLabel = NSTextField(labelWithString: "API Key:")
        apiKeyLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        apiKeyLabel.alignment = .right
        contentView.addSubview(apiKeyLabel)

        apiKeyField = NSSecureTextField()
        apiKeyField.frame = NSRect(x: 130, y: yOffset, width: 410, height: 24)
        apiKeyField.setAccessibilityLabel("API Key")
        apiKeyField.toolTip = "Optional. Jellyfin Dashboard \u{2192} API Keys. Media URLs in the MPV playlist use this instead of your login token, so a mid-session password change or token revocation can't kill the rest of the queue. Leave empty to use the login token."
        apiKeyField.placeholderString = "Leave empty to use your login token"
        contentView.addSubview(apiKeyField)
        yOffset -= 36

        // Test Connection
        testButton = NSButton(title: "Test Connection", target: self, action: #selector(testConnection))
        testButton.frame = NSRect(x: 130, y: yOffset, width: 130, height: 28)
        testButton.bezelStyle = .rounded
        contentView.addSubview(testButton)

        statusLabel = NSTextField(labelWithString: "")
        statusLabel.frame = NSRect(x: 270, y: yOffset + 4, width: 290, height: 20)
        statusLabel.font = NSFont.systemFont(ofSize: 12)
        statusLabel.maximumNumberOfLines = 1
        statusLabel.lineBreakMode = .byTruncatingTail
        contentView.addSubview(statusLabel)
        yOffset -= 30

        // Separator
        let separator1 = NSBox()
        separator1.boxType = .separator
        separator1.frame = NSRect(x: 20, y: yOffset, width: 540, height: 1)
        contentView.addSubview(separator1)
        yOffset -= 20

        // MARK: - Playback Section
        let playbackLabel = sectionLabel("Playback")
        playbackLabel.frame = NSRect(x: 20, y: yOffset, width: 520, height: 20)
        contentView.addSubview(playbackLabel)
        yOffset -= 30

        // MPV Path with Browse button
        let mpvLabel = NSTextField(labelWithString: "MPV Path:")
        mpvLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        mpvLabel.alignment = .right
        contentView.addSubview(mpvLabel)

        mpvPathField = NSTextField()
        mpvPathField.frame = NSRect(x: 130, y: yOffset, width: 320, height: 24)
        mpvPathField.setAccessibilityLabel("MPV Path")
        mpvPathField.toolTip = "Full path to the mpv binary (e.g. /opt/homebrew/bin/mpv)"
        contentView.addSubview(mpvPathField)

        let browseButton = NSButton(title: "Choose\u{2026}", target: self, action: #selector(browseMpvPath))
        browseButton.frame = NSRect(x: 458, y: yOffset, width: 80, height: 24)
        browseButton.bezelStyle = .rounded
        contentView.addSubview(browseButton)
        yOffset -= 36

        // Device Name
        let deviceNameLabel = NSTextField(labelWithString: "Device Name:")
        deviceNameLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        deviceNameLabel.alignment = .right
        contentView.addSubview(deviceNameLabel)

        deviceNameField = NSTextField()
        deviceNameField.frame = NSRect(x: 130, y: yOffset, width: 410, height: 24)
        deviceNameField.setAccessibilityLabel("Device Name")
        contentView.addSubview(deviceNameField)
        yOffset -= 36

        // Device ID
        let deviceIdLabel = NSTextField(labelWithString: "Device ID:")
        deviceIdLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        deviceIdLabel.alignment = .right
        contentView.addSubview(deviceIdLabel)

        deviceIdField = NSTextField()
        deviceIdField.frame = NSRect(x: 130, y: yOffset, width: 410, height: 24)
        deviceIdField.setAccessibilityLabel("Device ID")
        deviceIdField.toolTip = "Leave empty to auto-generate a unique ID per config"
        contentView.addSubview(deviceIdField)
        yOffset -= 36

        // IPC Socket Path
        let ipcLabel = NSTextField(labelWithString: "IPC Socket:")
        ipcLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        ipcLabel.alignment = .right
        contentView.addSubview(ipcLabel)

        ipcSocketPathField = NSTextField()
        ipcSocketPathField.frame = NSRect(x: 130, y: yOffset, width: 410, height: 24)
        ipcSocketPathField.setAccessibilityLabel("IPC Socket")
        ipcSocketPathField.toolTip = "MPV control socket path (max 100 characters)"
        ipcSocketPathField.placeholderString = ConfigParser.defaultIpcSocketPath()
        contentView.addSubview(ipcSocketPathField)
        yOffset -= 36

        // MPV Flags
        let flagsLabel = NSTextField(labelWithString: "MPV Flags:")
        flagsLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 24)
        flagsLabel.alignment = .right
        contentView.addSubview(flagsLabel)

        mpvFlagsField = NSTextField()
        mpvFlagsField.frame = NSRect(x: 130, y: yOffset, width: 410, height: 24)
        mpvFlagsField.setAccessibilityLabel("MPV Flags")
        mpvFlagsField.toolTip = "Comma-separated extra mpv arguments (e.g. --hwdec=auto, --vo=gpu-next)"
        mpvFlagsField.placeholderString = "--hwdec=auto, --vo=gpu-next"
        contentView.addSubview(mpvFlagsField)
        yOffset -= 30

        // Separator
        let separator2 = NSBox()
        separator2.boxType = .separator
        separator2.frame = NSRect(x: 20, y: yOffset, width: 540, height: 1)
        contentView.addSubview(separator2)
        yOffset -= 20

        // MARK: - Options Section
        let optionsLabel = sectionLabel("Options")
        optionsLabel.frame = NSRect(x: 20, y: yOffset, width: 540, height: 20)
        contentView.addSubview(optionsLabel)
        yOffset -= 28

        // Checkboxes in two columns
        let leftX: CGFloat = 130
        let rightX: CGFloat = 340
        let checkboxWidth: CGFloat = 200
        let checkboxHeight: CGFloat = 22
        let rowSpacing: CGFloat = 26

        // Row 1
        fullscreenCheckbox = NSButton(checkboxWithTitle: "Start in fullscreen", target: nil, action: nil)
        fullscreenCheckbox.frame = NSRect(x: leftX, y: yOffset, width: checkboxWidth, height: checkboxHeight)
        contentView.addSubview(fullscreenCheckbox)

        autoCloseCheckbox = NSButton(checkboxWithTitle: "Close when playback ends", target: nil, action: nil)
        autoCloseCheckbox.frame = NSRect(x: rightX, y: yOffset, width: checkboxWidth, height: checkboxHeight)
        contentView.addSubview(autoCloseCheckbox)
        yOffset -= rowSpacing

        // Row 2
        headlessCheckbox = NSButton(checkboxWithTitle: "Headless mode", target: nil, action: nil)
        headlessCheckbox.frame = NSRect(x: leftX, y: yOffset, width: checkboxWidth, height: checkboxHeight)
        contentView.addSubview(headlessCheckbox)

        verboseCheckbox = NSButton(checkboxWithTitle: "Verbose logging", target: nil, action: nil)
        verboseCheckbox.frame = NSRect(x: rightX, y: yOffset, width: checkboxWidth, height: checkboxHeight)
        contentView.addSubview(verboseCheckbox)
        yOffset -= rowSpacing

        // Row 3 — intro skipping is a 3-state choice (HIG: radio buttons)
        let skipLabel = NSTextField(labelWithString: "Intro skipping:")
        skipLabel.frame = NSRect(x: 20, y: yOffset, width: 100, height: 22)
        skipLabel.alignment = .right
        contentView.addSubview(skipLabel)

        skipAutoRadio = NSButton(radioButtonWithTitle: "Auto-skip", target: nil, action: nil)
        skipAutoRadio.frame = NSRect(x: leftX, y: yOffset, width: 110, height: 22)
        contentView.addSubview(skipAutoRadio)

        skipPromptRadio = NSButton(radioButtonWithTitle: "Show prompt", target: nil, action: nil)
        skipPromptRadio.frame = NSRect(x: leftX + 115, y: yOffset, width: 120, height: 22)
        contentView.addSubview(skipPromptRadio)

        skipDisableRadio = NSButton(radioButtonWithTitle: "Off", target: nil, action: nil)
        skipDisableRadio.frame = NSRect(x: leftX + 240, y: yOffset, width: 80, height: 22)
        contentView.addSubview(skipDisableRadio)
        yOffset -= 20

        // Separator
        let separator3 = NSBox()
        separator3.boxType = .separator
        separator3.frame = NSRect(x: 20, y: yOffset, width: 520, height: 1)
        contentView.addSubview(separator3)
        yOffset -= 20

        // MARK: - General Section
        launchAtLoginCheckbox = NSButton(checkboxWithTitle: "Open at Login", target: self, action: #selector(toggleLaunchAtLogin))
        launchAtLoginCheckbox.frame = NSRect(x: 130, y: yOffset, width: 200, height: 22)
        launchAtLoginCheckbox.state = SMAppService.mainApp.status == .enabled ? .on : .off
        contentView.addSubview(launchAtLoginCheckbox)

        // MARK: - Bottom buttons (HIG: default button rightmost, Escape = Cancel)
        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancelButton.frame = NSRect(x: 380, y: 20, width: 80, height: 32)
        cancelButton.keyEquivalent = "\u{1b}"
        contentView.addSubview(cancelButton)

        let saveButton = NSButton(title: "Save", target: self, action: #selector(saveConfig))
        saveButton.frame = NSRect(x: 470, y: 20, width: 80, height: 32)
        saveButton.keyEquivalent = "\r"
        contentView.addSubview(saveButton)
    }

    private func sectionLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.boldSystemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        return label
    }

    private func selectedConfigFileName() -> String {
        return ConfigParser.selectedConfigFileName()
    }

    @objc private func configFileChanged() {
        guard let selected = configFilePopup.titleOfSelectedItem else { return }
        UserDefaults.standard.set(selected, forKey: "selectedConfigFile")
        loadConfig()
    }

    @objc private func refreshConfigFiles() {
        populateConfigFiles()
        loadConfig()
    }

    private func populateConfigFiles() {
        configFilePopup.removeAllItems()
        let appSupport = ConfigParser.applicationSupportDir()
        let fileManager = FileManager.default
        guard let files = try? fileManager.contentsOfDirectory(atPath: appSupport) else { return }
        let configFiles = files.filter { $0.hasSuffix(".js") && ($0 == "config.js" || $0.hasPrefix("config.")) }.sorted()
        if configFiles.isEmpty {
            configFilePopup.addItem(withTitle: "config.js")
        } else {
            configFilePopup.addItems(withTitles: configFiles)
        }
        let selected = selectedConfigFileName()
        if let index = configFilePopup.itemTitles.firstIndex(of: selected) {
            configFilePopup.selectItem(at: index)
        }
    }

    private func loadConfig() {
        let configFileName = selectedConfigFileName()
        let configPath = ConfigParser.configPath(fileName: configFileName)
        guard let content = try? String(contentsOfFile: configPath, encoding: .utf8) else { return }

        serverUrlField.stringValue = ConfigParser.extractValue(from: content, key: "serverUrl")
        usernameField.stringValue = ConfigParser.extractValue(from: content, key: "username")
        passwordField.stringValue = ConfigParser.extractValue(from: content, key: "password")
        // Optional: empty means the shim falls back to the login token.
        apiKeyField.stringValue = ConfigParser.extractValue(from: content, key: "apiKey")

        var mpvPath = ConfigParser.extractValue(from: content, key: "mpvPath")
        if mpvPath.isEmpty { mpvPath = ConfigParser.defaultMpvPath() }
        mpvPathField.stringValue = mpvPath

        var deviceName = ConfigParser.extractValue(from: content, key: "deviceName")
        if deviceName.isEmpty { deviceName = "Jellyfin MPV Play" }
        deviceNameField.stringValue = deviceName

        // Empty deviceId is valid: shim.js then generates a unique per-config id.
        deviceIdField.stringValue = ConfigParser.extractValue(from: content, key: "deviceId")

        var ipcPath = ConfigParser.extractValue(from: content, key: "ipcSocketPath")
        if ipcPath.isEmpty { ipcPath = ConfigParser.defaultIpcSocketPath() }
        ipcSocketPathField.stringValue = ipcPath

        mpvFlagsField.stringValue = ConfigParser.extractValue(from: content, key: "mpvFlags")

        fullscreenCheckbox.state = ConfigParser.extractValue(from: content, key: "fullscreen") == "true" ? .on : .off
        autoCloseCheckbox.state = ConfigParser.extractValue(from: content, key: "autoClose") == "true" ? .on : .off
        headlessCheckbox.state = ConfigParser.extractValue(from: content, key: "headless") == "true" ? .on : .off
        let autoSkip = ConfigParser.extractValue(from: content, key: "autoSkipIntros") == "true"
        let skipOff = ConfigParser.extractValue(from: content, key: "disableSkipIntro") == "true"
        skipAutoRadio.state = autoSkip && !skipOff ? .on : .off
        skipDisableRadio.state = skipOff ? .on : .off
        skipPromptRadio.state = (!autoSkip && !skipOff) || (autoSkip && skipOff) ? .on : .off
        verboseCheckbox.state = ConfigParser.extractValue(from: content, key: "verbose") == "true" ? .on : .off
    }

    @objc private func browseMpvPath() {
        let panel = NSOpenPanel()
        panel.title = "Select MPV Binary"
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        if !mpvPathField.stringValue.isEmpty {
            let url = URL(fileURLWithPath: mpvPathField.stringValue)
            panel.directoryURL = url.deletingLastPathComponent()
        }
        panel.begin { [weak self] response in
            if response == .OK, let url = panel.url {
                self?.mpvPathField.stringValue = url.path
            }
        }
    }

    @objc private func testConnection() {
        guard !serverUrlField.stringValue.isEmpty,
              !usernameField.stringValue.isEmpty,
              !passwordField.stringValue.isEmpty else {
            statusLabel.stringValue = "Fill in all fields first"
            statusLabel.textColor = .systemYellow
            return
        }

        testButton.isEnabled = false
        statusLabel.stringValue = "Testing..."
        statusLabel.textColor = .labelColor

        let deviceId = deviceIdField.stringValue.isEmpty ? "test-device" : deviceIdField.stringValue
        let deviceName = deviceNameField.stringValue.isEmpty ? "Jellyfin MPV Play" : deviceNameField.stringValue

        ConfigParser.testConnection(server: serverUrlField.stringValue, username: usernameField.stringValue, password: passwordField.stringValue, deviceId: deviceId, deviceName: deviceName) { [weak self] success, message in
            self?.testButton.isEnabled = true
            self?.statusLabel.stringValue = message
            self?.statusLabel.textColor = success ? .systemGreen : .systemRed
        }
    }

    @objc private func saveConfig() {
        guard !serverUrlField.stringValue.isEmpty,
              !usernameField.stringValue.isEmpty,
              !passwordField.stringValue.isEmpty else {
            let alert = NSAlert()
            alert.messageText = "Missing required fields"
            alert.informativeText = "Server URL, Username, and Password are required."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            if let window = window {
                alert.beginSheetModal(for: window)
            } else {
                alert.runModal()
            }
            return
        }

        let managedKeys = ["serverUrl", "username", "password", "apiKey", "mpvPath", "deviceName", "deviceId",
                           "ipcSocketPath", "mpvFlags", "fullscreen", "autoClose", "headless",
                           "autoSkipIntros", "disableSkipIntro", "verbose"]
        var lines: [String] = [
            "    serverUrl: '\(ConfigParser.escapeConfigValue(serverUrlField.stringValue))',",
            "    username: '\(ConfigParser.escapeConfigValue(usernameField.stringValue))',",
            "    password: '\(ConfigParser.escapeConfigValue(passwordField.stringValue))',",
            "    mpvPath: '\(ConfigParser.escapeConfigValue(mpvPathField.stringValue))',",
            "    deviceName: '\(ConfigParser.escapeConfigValue(deviceNameField.stringValue))',",
            "    deviceId: '\(ConfigParser.escapeConfigValue(deviceIdField.stringValue))',",
        ]

        // Optional — omitted when empty, so the shim falls back to the login token.
        let apiKey = apiKeyField.stringValue.trimmingCharacters(in: .whitespaces)
        if !apiKey.isEmpty {
            lines.append("    apiKey: '\(ConfigParser.escapeConfigValue(apiKey))',")
        }

        let ipcPath = ipcSocketPathField.stringValue.trimmingCharacters(in: .whitespaces)
        if !ipcPath.isEmpty {
            lines.append("    ipcSocketPath: '\(ConfigParser.escapeConfigValue(ipcPath))',")
        }
        let mpvFlags = mpvFlagsField.stringValue.trimmingCharacters(in: .whitespaces)
        if !mpvFlags.isEmpty {
            // Split on commas first (flag values may contain spaces); fall back
            // to whitespace splitting when the user typed space-separated flags.
            var flags = mpvFlags.components(separatedBy: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            if flags.count <= 1 {
                flags = mpvFlags.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
            }
            let rendered = flags
                .map { "'\(ConfigParser.escapeConfigValue($0))'" }
                .joined(separator: ", ")
            lines.append("    mpvFlags: [\(rendered)],")
        }

        lines.append("    fullscreen: \(fullscreenCheckbox.state == .on ? "true" : "false"),")
        lines.append("    autoClose: \(autoCloseCheckbox.state == .on ? "true" : "false"),")
        lines.append("    headless: \(headlessCheckbox.state == .on ? "true" : "false"),")
        lines.append("    autoSkipIntros: \(skipAutoRadio.state == .on ? "true" : "false"),")
        lines.append("    disableSkipIntro: \(skipDisableRadio.state == .on ? "true" : "false"),")
        lines.append("    verbose: \(verboseCheckbox.state == .on ? "true" : "false"),")

        // The panel owns all 15 keys. Everything else in the file (comments,
        // user-added keys) is preserved verbatim; a managed key whose field is
        // empty is omitted (e.g. clearing MPV Flags removes the option).
        let configFileName = selectedConfigFileName()
        let existing = try? String(contentsOfFile: ConfigParser.configPath(fileName: configFileName), encoding: .utf8)
        let config = ConfigParser.buildConfig(managedKeys: managedKeys, managedLines: lines, preservingFrom: existing)
        let configPath = ConfigParser.configPath(fileName: configFileName)
        do {
            try config.write(toFile: configPath, atomically: true, encoding: .utf8)
            onSave?()
            window?.close()
        } catch {
            let alert = NSAlert()
            alert.messageText = "Failed to save config"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            if let window = window {
                alert.beginSheetModal(for: window)
            } else {
                alert.runModal()
            }
        }
    }

    @objc private func cancel() {
        window?.close()
    }

    @objc private func toggleLaunchAtLogin() {
        do {
            if launchAtLoginCheckbox.state == .on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            launchAtLoginCheckbox.state = launchAtLoginCheckbox.state == .on ? .off : .on
            let alert = NSAlert()
            alert.messageText = "Failed to update login item"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }
}
