import Foundation

enum ConfigParser {
    private static func stripComments(from content: String) -> String {
        return content.components(separatedBy: .newlines)
            .map { line -> String in
                // Strip whole-line comments (including indented ones like "    // key: x")
                if line.range(of: "^\\s*//", options: .regularExpression) != nil {
                    return ""
                }
                // Strip trailing // comments, but only when preceded by whitespace
                // (so URLs like https:// survive)
                if let range = line.range(of: "\\s//", options: .regularExpression) {
                    return String(line[line.startIndex..<range.lowerBound])
                }
                return line
            }
            .joined(separator: "\n")
    }

    static func extractValue(from content: String, key: String) -> String {
        let stripped = stripComments(from: content)
        let escapedKey = NSRegularExpression.escapedPattern(for: key)
        // Word boundary so key "deviceId" does not match "mydeviceId"
        let anchored = "(?<![A-Za-z0-9_])\(escapedKey):"
        // Match: key: ['a', 'b'] or key: ["a", "b"] (string arrays) -> "a, b"
        let arrayPattern = "\(anchored)\\s*\\[([^\\]]*)\\]"
        if let regex = try? NSRegularExpression(pattern: arrayPattern),
           let match = regex.firstMatch(in: stripped, range: NSRange(stripped.startIndex..., in: stripped)),
           let range = Range(match.range(at: 1), in: stripped) {
            let inner = String(stripped[range])
            let itemPattern = "['\"]([^'\"]*)['\"]"
            var items: [String] = []
            if let itemRegex = try? NSRegularExpression(pattern: itemPattern) {
                for m in itemRegex.matches(in: inner, range: NSRange(inner.startIndex..., in: inner)) {
                    if let r = Range(m.range(at: 1), in: inner) {
                        items.append(unescapeConfigValue(String(inner[r])))
                    }
                }
            }
            return items.joined(separator: ", ")
        }
        // Match: key: 'value' or key: "value" (quoted strings)
        let quotedPattern = "\(anchored)\\s*(['\"])([^'\"]*(?:\\\\.[^'\"]*)*)\\1"
        if let regex = try? NSRegularExpression(pattern: quotedPattern),
           let match = regex.firstMatch(in: stripped, range: NSRange(stripped.startIndex..., in: stripped)),
           let range = Range(match.range(at: 2), in: stripped) {
            return unescapeConfigValue(String(stripped[range]))
        }
        // Match: key: true/false (booleans)
        let boolPattern = "\(anchored)\\s*(true|false)"
        if let regex = try? NSRegularExpression(pattern: boolPattern),
           let match = regex.firstMatch(in: stripped, range: NSRange(stripped.startIndex..., in: stripped)),
           let range = Range(match.range(at: 1), in: stripped) {
            return String(stripped[range])
        }
        // Match: key: 123 (numbers)
        let numberPattern = "\(anchored)\\s*(\\d+)"
        if let regex = try? NSRegularExpression(pattern: numberPattern),
           let match = regex.firstMatch(in: stripped, range: NSRange(stripped.startIndex..., in: stripped)),
           let range = Range(match.range(at: 1), in: stripped) {
            return String(stripped[range])
        }
        return ""
    }

    private static func unescapeConfigValue(_ value: String) -> String {
        var result = value
        result = result.replacingOccurrences(of: "\\\\", with: "\u{0000}")
        result = result.replacingOccurrences(of: "\\'", with: "'")
        result = result.replacingOccurrences(of: "\\\"", with: "\"")
        result = result.replacingOccurrences(of: "\\n", with: "\n")
        result = result.replacingOccurrences(of: "\\r", with: "\r")
        result = result.replacingOccurrences(of: "\\t", with: "\t")
        result = result.replacingOccurrences(of: "\u{0000}", with: "\\")
        return result
    }

    static func applicationSupportDir() -> String {
        let paths = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
        guard let appSupport = paths.first else {
            return NSHomeDirectory() + "/Library/Application Support/JellyfinMpvPlay"
        }
        return appSupport.appendingPathComponent("JellyfinMpvPlay").path
    }

    static func configPath(fileName: String = "config.js") -> String {
        return applicationSupportDir() + "/\(fileName)"
    }

    static func selectedConfigFileName() -> String {
        return UserDefaults.standard.string(forKey: "selectedConfigFile") ?? "config.js"
    }

    static func loadConfigContent(fileName: String? = nil) -> String? {
        let name = fileName ?? selectedConfigFileName()
        return try? String(contentsOfFile: configPath(fileName: name), encoding: .utf8)
    }

    // Same default as shim.js: $XDG_RUNTIME_DIR/mpv-ipc.sock when set, else /tmp.
    static func defaultIpcSocketPath() -> String {
        if let xdg = ProcessInfo.processInfo.environment["XDG_RUNTIME_DIR"], !xdg.isEmpty {
            return xdg + "/mpv-ipc.sock"
        }
        return "/tmp/mpv-ipc.sock"
    }

    // Homebrew path matching the CPU architecture, falling back to PATH lookup.
    static func defaultMpvPath() -> String {
        var sysinfo = utsname()
        uname(&sysinfo)
        let machine = String(bytes: Data(bytes: &sysinfo.machine, count: Int(_SYS_NAMELEN)), encoding: .utf8) ?? ""
        return machine.contains("arm64") ? "/opt/homebrew/bin/mpv" : "/usr/local/bin/mpv"
    }

    // Builds config file content from the managed key lines (the ones the UI owns),
    // then passes through every OTHER line of the existing content unchanged —
    // comments, user-added keys, arrays — so saving never silently deletes options.
    // `managedKeys` must list every key the UI controls (whether or not a line is
    // emitted for it) so stale values of those keys are replaced, not duplicated.
    static func buildConfig(managedKeys: [String], managedLines: [String], preservingFrom existing: String?) -> String {
        var out: [String] = ["module.exports = {"]
        out.append(contentsOf: managedLines)
        if let existing = existing {
            let managed = Set(managedKeys)
            for rawLine in existing.components(separatedBy: .newlines) {
                let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                if trimmed.contains("module.exports") { continue }
                if trimmed == "};" || trimmed == "}" { continue }
                if let key = lineKey(trimmed), managed.contains(key) { continue }
                out.append(rawLine)
            }
        }
        out.append("};")
        return out.joined(separator: "\n")
    }

    private static func lineKey(_ trimmedLine: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: "^([A-Za-z_][A-Za-z0-9_]*):"),
              let match = regex.firstMatch(in: trimmedLine, range: NSRange(trimmedLine.startIndex..., in: trimmedLine)),
              let range = Range(match.range(at: 1), in: trimmedLine) else {
            return nil
        }
        return String(trimmedLine[range])
    }

    static func escapeConfigValue(_ s: String) -> String {
        return s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
    }

    static func testConnection(server: String, username: String, password: String, deviceId: String = "test", deviceName: String = "Jellyfin MPV Play", completion: @escaping (Bool, String) -> Void) {
        let trimmedServer = server.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmedServer.isEmpty, !username.isEmpty, !password.isEmpty else {
            completion(false, "Fill in all fields")
            return
        }

        guard let url = URL(string: "\(trimmedServer)/Users/AuthenticateByName"),
              let scheme = url.scheme?.lowercased(),
              (scheme == "http" || scheme == "https") else {
            completion(false, "Invalid URL (use http:// or https://)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
        let authHeader = "MediaBrowser Client=\"Jellyfin MPV Play\", Device=\"\(deviceName)\", DeviceId=\"\(deviceId)\", Version=\"\(version)\""
        request.addValue(authHeader, forHTTPHeaderField: "Authorization")
        let body: [String: Any] = ["Username": username, "Pw": password]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    completion(false, "Failed: \(error.localizedDescription)")
                    return
                }
                guard let httpResponse = response as? HTTPURLResponse else {
                    completion(false, "Invalid response")
                    return
                }
                if httpResponse.statusCode == 200 {
                    completion(true, "Connected")
                } else {
                    completion(false, "Failed: HTTP \(httpResponse.statusCode)")
                }
            }
        }.resume()
    }
}
