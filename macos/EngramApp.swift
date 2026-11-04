import AppKit

// The menu bar process controls a separate launchd worker. Closing this UI never owns its lifetime.
final class EngramApp: NSObject, NSApplicationDelegate {
    let role = Bundle.main.object(forInfoDictionaryKey: "EngramRole") as? String ?? "server"
    var item: NSStatusItem!
    var startupItem: NSMenuItem!
    var stateItem: NSMenuItem!
    var timer: Timer?
    var version = "Engram (offline)"
    var serverURL: URL?
    var tokenFile: String?
    var workspace: String?
    var projectDir: String?
    var outbox: String?
    var dashboardURL: URL?
    let files = FileManager.default
    var home: URL { files.homeDirectoryForCurrentUser }
    var label: String { "org.engram.\(role).worker" }
    var appLabel: String { "org.engram.\(role).app" }
    var domain: String { "gui/\(getuid())" }
    var agentDir: URL { home.appendingPathComponent("Library/LaunchAgents") }
    var workerPlist: URL { agentDir.appendingPathComponent("\(label).plist") }
    var appPlist: URL { agentDir.appendingPathComponent("\(appLabel).plist") }
    var config: URL { home.appendingPathComponent(".config/engram/\(role).env") }
    var log: URL { home.appendingPathComponent("Library/Logs/Engram/\(role == "client" ? "client-daemon" : role).log") }
    var startup: Bool {
        get { UserDefaults.standard.object(forKey: "launchAtLogin") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "launchAtLogin") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let id = Bundle.main.bundleIdentifier, NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { $0.processIdentifier != getpid() }) { NSApp.terminate(nil); return }
        NSApp.setActivationPolicy(.accessory)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let image = NSImage(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("menu_bar.png"))
        image?.size = NSSize(width: 20, height: 20)
        image?.isTemplate = true
        item.button?.image = image
        item.button?.title = role == "client" ? version : "Engram \(role.capitalized)"
        item.button?.toolTip = role == "client" ? version : "Engram \(role.capitalized)"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: role == "client" ? version : "Engram \(role.capitalized)", action: nil, keyEquivalent: ""))
        stateItem = NSMenuItem(title: "Background service", action: nil, keyEquivalent: "")
        menu.addItem(stateItem)
        menu.addItem(.separator())
        if role == "client" {
            add(menu, "Open dashboard", #selector(openDashboard))
            add(menu, "Start daemon", #selector(startWorker))
            add(menu, "Stop daemon", #selector(stopWorker))
            add(menu, "Show logs", #selector(showLog))
            menu.addItem(.separator())
            add(menu, "Quit", #selector(quit))
            item.menu = menu
            do {
                try prepare()
                if startup { try installAppAgent() }
                loadClientConfig()
                if clientReady { try startClientDaemon() } else { stateItem.title = "Configure client endpoint and token file" }
            } catch { showError(error) }
            refreshVersion()
            timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refreshVersion() }
            return
        }
        add(menu, "Start Background Service", #selector(startWorker))
        add(menu, "Stop Background Service", #selector(stopWorker))
        add(menu, "Edit Configuration…", #selector(editConfiguration))
        add(menu, "Show Service Log", #selector(showLog))
        startupItem = add(menu, "Start at Login", #selector(toggleStartup))
        menu.addItem(.separator())
        add(menu, "Quit Menu Bar App (service keeps running)", #selector(quit))
        item.menu = menu
        do {
            try prepare()
            if startup { try installAppAgent() }
            try startService()
        } catch { showError(error) }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
    }
    @discardableResult func add(_ menu: NSMenu, _ title: String, _ action: Selector) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
        entry.target = self
        menu.addItem(entry)
        return entry
    }
    func prepare() throws {
        for directory in [agentDir, config.deletingLastPathComponent(), log.deletingLastPathComponent()] {
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        if !files.fileExists(atPath: config.path) {
            let text = role == "client"
                ? "# Configure an authorized server endpoint and a separate 0600 token file.\nENGRAM_MCP_URL=\nENGRAM_TOKEN_FILE=\(home.path)/.config/engram/client.token\nENGRAM_WORKSPACE=\nENGRAM_PROJECT_DIR=\n# Optional: ENGRAM_OUTBOX, ENGRAM_DASHBOARD_URL\n"
                : "# Server defaults to loopback. Configure HTTPS ingress and scoped auth for remote access.\nMDB_MCP_HTTP_HOST=127.0.0.1\nMDB_MCP_HTTP_PORT=3333\n# ENGRAM_DATA_DIR and authentication options can also be set here.\n"
            try text.write(to: config, atomically: true, encoding: .utf8)
            try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
        }
    }
    func loadClientConfig() {
        guard let content = try? String(contentsOf: config, encoding: .utf8) else { return }
        var values: [String: String] = [:]
        for line in content.split(whereSeparator: \.isNewline) {
            let part = line.trimmingCharacters(in: .whitespaces)
            guard !part.isEmpty, !part.hasPrefix("#"), let equal = part.firstIndex(of: "=") else { continue }
            let key = String(part[..<equal]); var value = String(part[part.index(after: equal)...]).trimmingCharacters(in: .whitespaces)
            if value.count >= 2, (value.first == "\"" && value.last == "\"") || (value.first == "'" && value.last == "'") { value = String(value.dropFirst().dropLast()) }
            values[key] = value
        }
        serverURL = values["ENGRAM_MCP_URL"].flatMap(URL.init(string:))
        tokenFile = values["ENGRAM_TOKEN_FILE"]
        workspace = values["ENGRAM_WORKSPACE"]
        projectDir = values["ENGRAM_PROJECT_DIR"]
        outbox = values["ENGRAM_OUTBOX"]
        dashboardURL = values["ENGRAM_DASHBOARD_URL"].flatMap(URL.init(string:))
    }
    func mdb(_ action: String) throws -> String {
        guard let backend = Bundle.main.resourceURL?.appendingPathComponent("backend"),
              let executable = Bundle.main.resourceURL?.appendingPathComponent("backend/runtime/bin/node"),
              files.fileExists(atPath: executable.path) else { throw NSError(domain: "Engram", code: 2, userInfo: [NSLocalizedDescriptionKey: "Bundled Engram runtime is unavailable"]) }
        let script = backend.appendingPathComponent("app/bin/mdb.js")
        let process = Process(); process.executableURL = executable
        process.arguments = [script.path, "service", action, "--platform", "macos"]
        if action == "install" {
            guard let url = serverURL?.absoluteString, let tokenFile else { throw NSError(domain: "Engram", code: 3, userInfo: [NSLocalizedDescriptionKey: "Set ENGRAM_MCP_URL and ENGRAM_TOKEN_FILE in client.env"]) }
            process.arguments = (process.arguments ?? []) + ["--url", url, "--token-file", tokenFile]
            if let workspace, !workspace.isEmpty { process.arguments?.append(contentsOf: ["--workspace", workspace]) }
            if let projectDir, !projectDir.isEmpty { process.arguments?.append(contentsOf: ["--project-dir", projectDir]) }
            if let outbox, !outbox.isEmpty { process.arguments?.append(contentsOf: ["--outbox", outbox]) }
        }
        let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
        try process.run(); let output = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        let text = String(data: output, encoding: .utf8) ?? ""
        if process.terminationStatus != 0 { throw NSError(domain: "Engram", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: text.isEmpty ? "mdb service \(action) failed" : text]) }
        return text
    }
    func startClientDaemon() throws { _ = try mdb("install") }
    var clientReady: Bool {
        guard serverURL != nil, let tokenFile, let attributes = try? files.attributesOfItem(atPath: tokenFile),
              let permissions = attributes[.posixPermissions] as? NSNumber else { return false }
        return permissions.intValue & 0o777 == 0o600
    }
    func refreshVersion() {
        guard role == "client", let source = serverURL else { setClientOffline(); return }
        var parts = URLComponents(url: source, resolvingAgainstBaseURL: false)
        parts?.path = "/version"; parts?.query = nil; parts?.fragment = nil
        guard let endpoint = parts?.url else { setClientOffline(); return }
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let next: String
            if let http = response as? HTTPURLResponse, http.statusCode == 200, let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
               json["name"] == "engram", let value = json["version"], !value.isEmpty { next = "Engram \(value)" }
            else { next = "Engram (offline)" }
            DispatchQueue.main.async {
                self.version = next; self.item.button?.title = next; self.item.button?.toolTip = next
                self.item.menu?.items.first?.title = next
                self.stateItem.title = next == "Engram (offline)" ? "Server unavailable" : "Server connected"
            }
        }.resume()
    }
    func setClientOffline() {
        version = "Engram (offline)"; item.button?.title = version; item.button?.toolTip = version
        item.menu?.items.first?.title = version; stateItem.title = "Server unavailable"
    }
    @discardableResult func launchctl(_ arguments: [String]) -> (Int32, String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        } catch { return (1, error.localizedDescription) }
    }
    func writePlist(_ data: [String: Any], _ url: URL) throws {
        let bytes = try PropertyListSerialization.data(fromPropertyList: data, format: .xml, options: 0)
        try bytes.write(to: url, options: .atomic)
        try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func workerDefinition() -> [String: Any] {
        ["Label": label, "ProgramArguments": [Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/engram-worker").path],
         "EnvironmentVariables": ["HOME": home.path], "RunAtLoad": true, "KeepAlive": true,
         "ThrottleInterval": 30, "StandardOutPath": log.path, "StandardErrorPath": log.path]
    }
    func installAppAgent() throws {
        try writePlist(["Label": appLabel, "ProgramArguments": [Bundle.main.executableURL!.path],
                        "RunAtLoad": true, "ProcessType": "Interactive"], appPlist)
        // launchd reads this at the next login; the current UI is already running.
    }
    var bootService: Bool { launchctl(["print", "system/org.engram.\(role).boot"]).0 == 0 }
    func startService() throws {
        if bootService { return }
        let loaded = launchctl(["print", "\(domain)/\(label)"]).0 == 0
        try writePlist(workerDefinition(), workerPlist)
        if !loaded {
            let result = launchctl(["bootstrap", domain, workerPlist.path])
            if result.0 != 0 { throw NSError(domain: "Engram", code: Int(result.0), userInfo: [NSLocalizedDescriptionKey: result.1]) }
        } else { launchctl(["kickstart", "\(domain)/\(label)"]) }
        if !startup { try files.removeItem(at: workerPlist) }
    }
    func refresh() {
        startupItem.state = startup ? .on : .off
        let result = launchctl(["print", bootService ? "system/org.engram.\(role).boot" : "\(domain)/\(label)"])
        stateItem.title = result.1.contains("state = running") ? "Background service running" : "Service stopped or awaiting configuration — see log"
    }
    func showError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Engram \(role.capitalized)"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }
    @objc func startWorker() { do { if role == "client" { loadClientConfig(); guard clientReady else { throw NSError(domain: "Engram", code: 4, userInfo: [NSLocalizedDescriptionKey: "Set ENGRAM_MCP_URL and a mode-0600 ENGRAM_TOKEN_FILE in client.env"]) }; _ = try mdb("start") } else { try prepare(); try startService() } } catch { showError(error) }; if role == "client" { refreshVersion() } else { refresh() } }
    @objc func stopWorker() {
        if role == "client" { do { _ = try mdb("stop") } catch { showError(error) }; stateItem.title = "Daemon stopped"; return }
        if bootService { showError(NSError(domain: "Engram", code: 1, userInfo: [NSLocalizedDescriptionKey: "This service starts at system boot. Stop it with the supplied install-macos-boot.mjs uninstall command using sudo."])); return }
        launchctl(["bootout", "\(domain)/\(label)"])
        if files.fileExists(atPath: workerPlist.path) { try? files.removeItem(at: workerPlist) }
        refresh()
    }
    @objc func toggleStartup() {
        startup.toggle()
        do {
            if startup { try installAppAgent(); if !bootService { try writePlist(workerDefinition(), workerPlist) } }
            else {
                for url in [appPlist, workerPlist] where files.fileExists(atPath: url.path) { try files.removeItem(at: url) }
            }
        } catch { showError(error) }
        refresh()
    }
    @objc func editConfiguration() { NSWorkspace.shared.open(config) }
    @objc func showLog() { NSWorkspace.shared.open(log) }
    @objc func openDashboard() {
        if let dashboardURL { NSWorkspace.shared.open(dashboardURL); return }
        if let serverURL { var parts = URLComponents(url: serverURL, resolvingAgainstBaseURL: false); parts?.path = "/dashboard"; if let url = parts?.url { NSWorkspace.shared.open(url) } }
    }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = EngramApp()
app.delegate = delegate
app.run()
