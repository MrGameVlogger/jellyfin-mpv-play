import Cocoa
import Foundation

enum ConnectionStatus {
    case disconnected
    case connected
    case playing
}

class NodeProcessManager {
    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var logHandler: (String) -> Void
    internal var statusHandler: (ConnectionStatus) -> Void
    private var notificationHandler: (String, String) -> Void
    private(set) var isPlaying = false
    private var restartCount = 0
    private var maxRestarts = 5
    private var isShuttingDown = false
    private var shutdownCompletion: (() -> Void)?
    private(set) var nowPlaying: String?
    var nowPlayingHandler: ((String?) -> Void)?
    var pauseStateHandler: ((Bool) -> Void)?
    private var isPaused = false
    private var stdoutData = Data()
    private var stderrData = Data()
    private var ipcSocketPath = ConfigParser.defaultIpcSocketPath()
    private var isStoppingPlayback = false
    private var logFileHandle: FileHandle?
    private var pendingRestart: DispatchWorkItem?
    private var lastErrorNotificationAt = Date.distantPast

    init(logHandler: @escaping (String) -> Void, statusHandler: @escaping (ConnectionStatus) -> Void, notificationHandler: @escaping (String, String) -> Void, nowPlayingHandler: ((String?) -> Void)? = nil) {
        self.logHandler = logHandler
        self.statusHandler = statusHandler
        self.notificationHandler = notificationHandler
        self.nowPlayingHandler = nowPlayingHandler
    }

    func start() {
        pendingRestart?.cancel()
        pendingRestart = nil
        closeLogFile()
        if let process = process, process.isRunning {
            process.terminationHandler = nil
            process.terminate()
            cleanupPipes()
        }
        isShuttingDown = false
        isStoppingPlayback = false
        let appSupport = ConfigParser.applicationSupportDir()
        let bundleResources = Bundle.main.resourcePath ?? ""
        let shimPath = appSupport + "/shim.js"
        let nodeModulesPath = bundleResources + "/node_modules"

        setupApplicationSupport()
        loadIpcSocketPath()
        openLogFile()

        guard FileManager.default.fileExists(atPath: shimPath) else {
            logHandler("ERROR: shim.js not found at \(shimPath)")
            return
        }

        let nodePath = findNodePath()
        guard !nodePath.isEmpty else {
            logHandler("ERROR: Node.js not found. Install Node.js or ensure it's bundled.")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        let selectedConfig = UserDefaults.standard.string(forKey: "selectedConfigFile") ?? "config.js"
        process.arguments = [shimPath, appSupport + "/" + selectedConfig]
        process.currentDirectoryURL = URL(fileURLWithPath: appSupport)
        var env = ProcessInfo.processInfo.environment
        env["NODE_PATH"] = nodeModulesPath
        process.environment = env

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.stdoutData.append(data)
                // Split at the last newline and decode only complete lines, lossily:
                // one invalid byte can never stall the stream forever, and partial
                // multibyte sequences stay buffered until their line completes.
                guard let nl = self.stdoutData.lastIndex(of: UInt8(ascii: "\n")) else {
                    if self.stdoutData.count > 1024 * 1024 { self.stdoutData.removeAll(keepingCapacity: true) }
                    return
                }
                let completeData = self.stdoutData[...nl]
                self.stdoutData = Data(self.stdoutData[self.stdoutData.index(after: nl)...])
                let str = String(decoding: completeData, as: UTF8.self)
                for line in str.components(separatedBy: .newlines) where !line.isEmpty {
                    self.processLogLine(line)
                }
            }
        }

        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.stderrData.append(data)
                guard let nl = self.stderrData.lastIndex(of: UInt8(ascii: "\n")) else {
                    if self.stderrData.count > 1024 * 1024 { self.stderrData.removeAll(keepingCapacity: true) }
                    return
                }
                let completeData = self.stderrData[...nl]
                self.stderrData = Data(self.stderrData[self.stderrData.index(after: nl)...])
                let str = String(decoding: completeData, as: UTF8.self)
                for line in str.components(separatedBy: .newlines) where !line.isEmpty {
                    self.logHandler("STDERR: \(line)")
                    self.processLogLine("STDERR: \(line)")
                }
            }
        }

        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isPlaying = false
                self.nowPlaying = nil
                self.nowPlayingHandler?(nil)
                self.statusHandler(.disconnected)
                let exitCode = proc.terminationStatus
                if self.isShuttingDown {
                    self.restartCount = 0
                    self.logHandler("Process terminated (exit code: \(exitCode))")
                } else if self.restartCount < self.maxRestarts {
                    self.restartCount += 1
                    let delay = min(pow(2.0, Double(self.restartCount)), 30.0)
                    self.logHandler("Process exited unexpectedly (code: \(exitCode)). Restarting in \(Int(delay))s... (attempt \(self.restartCount)/\(self.maxRestarts))")
                    // Cancellable: stop() must be able to prevent a restart that is
                    // already scheduled (otherwise a node process spawns after quit).
                    let work = DispatchWorkItem { [weak self] in
                        guard let self = self, !self.isShuttingDown else { return }
                        self.pendingRestart = nil
                        self.start()
                    }
                    self.pendingRestart = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
                } else {
                    self.logHandler("Process terminated (exit code: \(exitCode))")
                    self.restartCount = 0
                    self.logHandler("Max restart attempts reached. Click Restart to try again.")
                    self.showCrashAlert(exitCode: exitCode)
                }
            }
        }

        do {
            try process.run()
            self.process = process
            self.stdoutPipe = stdoutPipe
            self.stderrPipe = stderrPipe
            logHandler("Started node shim.js (PID: \(process.processIdentifier))")
        } catch {
            logHandler("ERROR: Failed to start node: \(error.localizedDescription)")
        }
    }

    func stop(completion: (() -> Void)? = nil) {
        if isShuttingDown {
            if let completion = completion {
                let existing = shutdownCompletion
                shutdownCompletion = { existing?(); completion() }
            }
            return
        }
        isShuttingDown = true
        shutdownCompletion = completion
        pendingRestart?.cancel()
        pendingRestart = nil
        let ipcPath = ipcSocketPath
        if let process = process, process.isRunning {
            let proc = process
            proc.terminationHandler = { [weak self] _ in
                // terminationHandler runs on an arbitrary thread — hop to main so
                // the shared buffers/pipes/state are only touched on one queue.
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.drainPipes()
                    self.resetPlaybackState()
                    self.statusHandler(.disconnected)
                    self.cleanupPipes()
                    if FileManager.default.fileExists(atPath: ipcPath) {
                        try? FileManager.default.removeItem(atPath: ipcPath)
                    }
                    self.restartCount = 0
                    self.shutdownCompletion?()
                    self.shutdownCompletion = nil
                }
            }
            proc.terminate()

            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                if proc.isRunning {
                    kill(pid_t(proc.processIdentifier), SIGKILL)
                }
            }
        } else {
            if FileManager.default.fileExists(atPath: ipcPath) {
                try? FileManager.default.removeItem(atPath: ipcPath)
            }
            resetPlaybackState()
            statusHandler(.disconnected)
            shutdownCompletion?()
            shutdownCompletion = nil
            cleanupPipes()
        }
    }

    // Reads any final output the child wrote before exiting (e.g. the
    // "Closing application" line) before the pipes are torn down.
    private func drainPipes() {
        for (pipe, isErr) in [(stdoutPipe, false), (stderrPipe, true)] {
            guard let data = pipe?.fileHandleForReading.availableData, !data.isEmpty else { continue }
            let str = String(decoding: data, as: UTF8.self)
            for line in str.components(separatedBy: .newlines) where !line.isEmpty {
                if isErr {
                    logHandler("STDERR: \(line)")
                    processLogLine("STDERR: \(line)")
                } else {
                    processLogLine(line)
                }
            }
        }
    }

    private func cleanupPipes() {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        stdoutPipe = nil
        stderrPipe = nil
        process = nil
        stdoutData = Data()
        stderrData = Data()
        closeLogFile()
    }

    private func openLogFile() {
        let dataDir = ConfigParser.applicationSupportDir() + "/data"
        do {
            try FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        } catch {
            logHandler("ERROR: Cannot create log directory \(dataDir): \(error.localizedDescription)")
            return
        }
        let formatter = DateFormatter()
        // No colons in the filename — Finder displays them as slashes
        formatter.dateFormat = "yyyy-MM-dd_HHmmss'Z'"
        formatter.timeZone = TimeZone(identifier: "UTC")
        let filename = "jellyfin-mpv-play-\(formatter.string(from: Date())).log"
        let logPath = (dataDir as NSString).appendingPathComponent(filename)
        if !FileManager.default.createFile(atPath: logPath, contents: nil) {
            logHandler("ERROR: Cannot create log file \(logPath)")
            return
        }
        logFileHandle = FileHandle(forWritingAtPath: logPath)
        if logFileHandle == nil {
            logHandler("ERROR: Cannot open log file for writing: \(logPath)")
        }
    }

    private func closeLogFile() {
        logFileHandle?.closeFile()
        logFileHandle = nil
    }

    private func writeToLogFile(_ line: String) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        do {
            try logFileHandle?.write(contentsOf: data)
        } catch {
            // Disk full / I/O error — keep the app alive, just stop file logging
            logHandler("WARN: log file write failed: \(error.localizedDescription)")
            closeLogFile()
        }
    }

    private func loadIpcSocketPath() {
        guard let content = ConfigParser.loadConfigContent() else { return }
        let path = ConfigParser.extractValue(from: content, key: "ipcSocketPath")
        if !path.isEmpty { ipcSocketPath = path }
    }

    func sendMpvCommand(_ command: String) {
        let path = ipcSocketPath
        guard FileManager.default.fileExists(atPath: path) else {
            logHandler("WARN: MPV IPC socket not found at \(path)")
            return
        }

        DispatchQueue.global().async { [weak self] in
            let sock = socket(AF_UNIX, SOCK_STREAM, 0)
            guard sock >= 0 else { return }
            defer { close(sock) }

            var noSigPipe: Int32 = 1
            setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

            var addr = sockaddr_un()
            addr.sun_family = sa_family_t(AF_UNIX)
            let pathBytes = Array(path.utf8CString)
            withUnsafeMutableBytes(of: &addr.sun_path) { buf in
                guard let baseAddr = buf.baseAddress else { return }
                // Truncate to fit in sun_path with null terminator
                let maxLen = min(pathBytes.count, buf.count - 1)
                _ = memcpy(baseAddr, pathBytes, maxLen)
                // Ensure null termination
                let nullPos = min(maxLen, buf.count - 1)
                baseAddr.storeBytes(of: 0, toByteOffset: nullPos, as: UInt8.self)
            }

            let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
            let connected = withUnsafePointer(to: &addr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    connect(sock, sockPtr, addrLen)
                }
            }

            guard connected == 0 else {
                DispatchQueue.main.async {
                    self?.logHandler("WARN: Failed to connect to MPV IPC socket")
                }
                return
            }

            let json = "\(command)\n"
            guard let data = json.data(using: .utf8) else { return }

            var totalSent = 0
            while totalSent < data.count {
                let result = data.withUnsafeBytes { buf -> Int in
                    guard let ptr = buf.baseAddress?.advanced(by: totalSent) else { return -1 }
                    return send(sock, ptr, data.count - totalSent, 0)
                }
                if result <= 0 {
                    DispatchQueue.main.async {
                        self?.logHandler("WARN: Failed to send MPV IPC command")
                    }
                    break
                }
                totalSent += result
            }
        }
    }

    func togglePause() {
        guard !isStoppingPlayback else { return }
        sendMpvCommand("{\"command\": [\"cycle\", \"pause\"]}")
    }

    func stopPlayback() {
        isStoppingPlayback = true
        resetPlaybackState()
        sendMpvCommand("{\"command\": [\"quit\"]}")
        // isStoppingPlayback is cleared by the "MPV closed" / "No more episodes"
        // log branches and by process termination. This timer is only a fallback:
        // mpv's graceful shutdown routinely exceeds 3s on network streams, and
        // clearing the gate early let stale log lines resurrect a phantom
        // "playing" state after the user pressed Stop.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            self?.isStoppingPlayback = false
        }
    }

    private func resetPlaybackState() {
        isPlaying = false
        isPaused = false
        nowPlaying = nil
        nowPlayingHandler?(nil)
        pauseStateHandler?(false)
        statusHandler(.connected)
    }

    private func processLogLine(_ line: String) {
        if line.hasPrefix("AV:") { return }

        logHandler(line)
        writeToLogFile(line)

        // Error notification runs BEFORE the state-transition chain so lines like
        // "MPV closed with error" still notify (the "MPV closed" branch below only
        // resets state). Markers are case-insensitive: most shim errors use a plain
        // "Error"/"warning" wording rather than the literal tokens ERROR/❌/FATAL.
        let lower = line.lowercased()
        if lower.contains("error") || lower.contains("fatal") || line.contains("❌") || line.contains("⚠️") {
            let now = Date()
            if now.timeIntervalSince(lastErrorNotificationAt) > 30 {
                lastErrorNotificationAt = now
                let message = line.count > 200 ? String(line.prefix(200)) + "…" : line
                notificationHandler("Error", message)
            }
        }

        // Parse structured logs: [timestamp] [component] message
        if line.contains("WebSocket connection established") {
            statusHandler(.connected)
            restartCount = 0
            notificationHandler("Connected", "Connected to Jellyfin server")
        } else if line.contains("Episode detected") {
            if isStoppingPlayback { return }
            if let title = extractTitleFromEpisode(line) {
                nowPlaying = title
                nowPlayingHandler?(title)
            }
            isPlaying = true
            statusHandler(.playing)
        } else if line.contains("File loaded by MPV") {
            if isStoppingPlayback { return }
            if !isPlaying {
                isPlaying = true
                statusHandler(.playing)
            }
        } else if line.contains("Starting next episode") || line.contains("Starting previous episode") || line.contains("Starting episode: ") {
            if isStoppingPlayback { return }
            if let title = extractTitleFromNextEpisode(line) {
                nowPlaying = title
                nowPlayingHandler?(title)
            }
        } else if line.contains("Playback paused") {
            if isStoppingPlayback { return }
            isPaused = true
            pauseStateHandler?(true)
        } else if line.contains("Playback resumed") {
            if isStoppingPlayback { return }
            isPaused = false
            pauseStateHandler?(false)
        } else if line.contains("No more episodes") {
            isStoppingPlayback = false
            resetPlaybackState()
        } else if line.contains("Closing application") || line.contains("MPV closed") || line.contains("Process terminated") {
            isStoppingPlayback = false
            resetPlaybackState()
        }
    }

    private func extractTitleFromNextEpisode(_ line: String) -> String? {
        if let range = line.range(of: "Starting next episode: ") {
            return String(line[range.upperBound...])
        }
        if let range = line.range(of: "Starting previous episode: ") {
            return String(line[range.upperBound...])
        }
        // Movie/music/video items (the shim logs this for non-episode playback)
        if let range = line.range(of: "Starting episode: ") {
            return String(line[range.upperBound...])
        }
        return nil
    }

    private func extractTitleFromEpisode(_ line: String) -> String? {
        if let range = line.range(of: "Episode detected: ") {
            return String(line[range.upperBound...]).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    private func setupApplicationSupport() {
        let appSupport = ConfigParser.applicationSupportDir()
        let dataDir = appSupport + "/data"
        let bundleResources = Bundle.main.resourcePath ?? ""

        try? FileManager.default.createDirectory(atPath: appSupport, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)

        // Copy bundle files over WITHOUT the old delete-then-copy pattern (a
        // failed copy used to leave the working file gone). Stage + replace.
        func stageReplace(_ bundled: String, to dest: String) {
            let staged = dest + ".staging"
            do {
                try? FileManager.default.removeItem(atPath: staged)
                try FileManager.default.copyItem(atPath: bundled, toPath: staged)
                _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: dest),
                                                          withItemAt: URL(fileURLWithPath: staged))
            } catch {
                logHandler("ERROR: Failed to install \((bundled as NSString).lastPathComponent): \(error.localizedDescription)")
            }
        }
        stageReplace(bundleResources + "/shim.js", to: appSupport + "/shim.js")
        stageReplace(bundleResources + "/package.json", to: appSupport + "/package.json")

        let configFile = appSupport + "/config.js"
        if !FileManager.default.fileExists(atPath: configFile) {
            let exampleConfig = bundleResources + "/config.example.js"
            do {
                try FileManager.default.copyItem(atPath: exampleConfig, toPath: configFile)
            } catch {
                logHandler("ERROR: Failed to create config.js: \(error.localizedDescription)")
            }
        }
    }

    private func showCrashAlert(exitCode: Int32) {
        let dataDir = ConfigParser.applicationSupportDir() + "/data"
        let logFiles = (try? FileManager.default.contentsOfDirectory(atPath: dataDir))?
            .filter { $0.hasSuffix(".log") }
            .sorted()
            .reversed() ?? []
        let latestLog = logFiles.first.map { "\(dataDir)/\($0)" } ?? "No log files found"

        let alert = NSAlert()
        alert.messageText = "Jellyfin MPV Play crashed"
        alert.informativeText = "The shim process exited unexpectedly (code: \(exitCode)).\n\nThis is a bug. Please report it with the log file:\n\(latestLog)"
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Open Log File")
        alert.addButton(withTitle: "Dismiss")

        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(fileURLWithPath: latestLog))
        }
    }

    // Returns true if the given node binary actually executes. Catches the case
    // where the binary exists but cannot run on this system — e.g. its
    // LC_BUILD_VERSION minos is newer than the running macOS (dyld load error),
    // or a foreign architecture — which FileManager.isExecutableFile cannot see.
    private func nodeRuns(_ path: String) -> Bool {
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: path)
        probe.arguments = ["--version"]
        probe.standardOutput = FileHandle.nullDevice
        probe.standardError = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        probe.terminationHandler = { _ in done.signal() }
        do {
            try probe.run()
        } catch {
            return false
        }
        if done.wait(timeout: .now() + 3) == .timedOut {
            probe.terminate()
            return false
        }
        return probe.terminationStatus == 0
    }

    private func findNodePath() -> String {
        // Prefer bundled Node from app Resources
        if let bundlePath = Bundle.main.resourcePath {
            let bundledNode = "\(bundlePath)/node/bin/node"
            if FileManager.default.isExecutableFile(atPath: bundledNode) {
                if nodeRuns(bundledNode) {
                    logHandler("Using bundled node: \(bundledNode)")
                    return bundledNode
                }
                logHandler("Bundled node is not runnable on this system, trying system node")
            }
        }

        // Fall back to system Node
        let paths = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]
        for path in paths {
            if FileManager.default.isExecutableFile(atPath: path) && nodeRuns(path) {
                logHandler("Using system node: \(path)")
                return path
            }
        }
        let nvmBase = NSHomeDirectory() + "/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmBase) {
            let sorted = versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            for v in sorted {
                let nodePath = "\(nvmBase)/\(v)/bin/node"
                if FileManager.default.isExecutableFile(atPath: nodePath) && nodeRuns(nodePath) {
                    logHandler("Using nvm node: \(nodePath)")
                    return nodePath
                }
            }
        }
        logHandler("ERROR: node not found in bundle or system")
        return ""
    }
}
