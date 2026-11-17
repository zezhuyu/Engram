import AppKit

// The menu bar process controls a separate launchd worker. Closing this UI never owns its lifetime.
final class EngramApp: NSObject, NSApplicationDelegate {
    let role = Bundle.main.object(forInfoDictionaryKey: "EngramRole") as? String ?? "server"
    var item: NSStatusItem!
    var startupItem: NSMenuItem!
    var stateItem: NSMenuItem!
    var dashboardStateItem: NSMenuItem?
    var dashboardLinkItem: NSMenuItem?
    var dashboardSetupURL: URL?
    var dashboardFirstTimeSetup = false
    var timer: Timer?
    var version = "Engram (offline)"
    var serverURL: URL?
    var tokenFile: String?
    var workspace: String?
    var projectDir: String?
    var outbox: String?
    var dashboardURL: URL?
    var dashboardPort = 4872
    var clientServiceError: String?
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
        installCommandLineShim()
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
        dashboardStateItem = NSMenuItem(title: "Dashboard: checking…", action: nil, keyEquivalent: "")
        menu.addItem(dashboardStateItem!)
        menu.addItem(.separator())
        if role == "client" {
            add(menu, "Open dashboard", #selector(openDashboard))
            dashboardLinkItem = add(menu, "Copy first-time sign-in link", #selector(copyDashboardSetupLink))
            dashboardLinkItem?.isHidden = true
            add(menu, "Start daemon", #selector(startWorker))
            add(menu, "Stop daemon", #selector(stopWorker))
            add(menu, "Show logs", #selector(showLog))
            menu.addItem(.separator())
            add(menu, "Quit Menu Bar App (daemon keeps running)", #selector(quit))
            add(menu, "Quit Engram Completely…", #selector(quitCompletely))
            item.menu = menu
            do {
                try prepare()
                if startup { try installAppAgent() }
                loadClientConfig()
                if clientReady { try startClientDaemon() } else { stateItem.title = "Configure client endpoint and token file" }
            } catch { clientServiceError = error.localizedDescription; stateItem.title = "Service error: \(error.localizedDescription)"; showError(error) }
            refreshVersion()
            refreshClientServiceStatus()
            timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refreshVersion(); self?.refreshClientServiceStatus() }
            return
        }
        add(menu, "Open dashboard", #selector(openDashboard))
        dashboardLinkItem = add(menu, "Copy first-time sign-in link", #selector(copyDashboardSetupLink))
        dashboardLinkItem?.isHidden = true
        menu.addItem(.separator())
        add(menu, "Start Background Service", #selector(startWorker))
        add(menu, "Stop Background Service", #selector(stopWorker))
        add(menu, "Edit Configuration…", #selector(editConfiguration))
        add(menu, "Show Service Log", #selector(showLog))
        startupItem = add(menu, "Start at Login", #selector(toggleStartup))
        menu.addItem(.separator())
        add(menu, "Quit Menu Bar App (service keeps running)", #selector(quit))
        add(menu, "Quit Engram Completely…", #selector(quitCompletely))
        item.menu = menu
        do {
            try prepare()
            if startup { try installAppAgent() }
            try startService()
        } catch { showError(error) }
        refresh()
        refreshServerDashboardStatus()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh(); self?.refreshServerDashboardStatus() }
    }
    // Best effort only: command installation must never prevent either app or its worker from starting.
    func installCommandLineShim() {
        guard let backend = Bundle.main.resourceURL?.appendingPathComponent("backend"),
              let node = Bundle.main.resourceURL?.appendingPathComponent("backend/runtime/bin/node"),
              files.fileExists(atPath: node.path) else { return }
        let process = Process(); process.executableURL = node
        process.arguments = [backend.appendingPathComponent("app/bin/mdb.js").path, "shim", "install", "--dir", home.appendingPathComponent(".local/bin").path]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return }
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
        if let value = values["ENGRAM_CLIENT_DASHBOARD_PORT"], let port = Int(value), (1...65535).contains(port) { dashboardPort = port }
    }
    func mdb(_ action: String, extraArguments: [String] = []) throws -> String {
        guard let backend = Bundle.main.resourceURL?.appendingPathComponent("backend"),
              let executable = Bundle.main.resourceURL?.appendingPathComponent("backend/runtime/bin/node"),
              files.fileExists(atPath: executable.path) else { throw NSError(domain: "Engram", code: 2, userInfo: [NSLocalizedDescriptionKey: "Bundled Engram runtime is unavailable"]) }
        let script = backend.appendingPathComponent("app/bin/mdb.js")
        let process = Process(); process.executableURL = executable
        process.arguments = [script.path, "service", action, "--platform", "macos"]
        process.arguments?.append(contentsOf: extraArguments)
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
    func startClientDaemon() throws { _ = try mdb("install"); _ = try mdb("start"); clientServiceError = nil }
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
        item.menu?.items.first?.title = version
    }
    func refreshClientServiceStatus() {
        guard role == "client", let dashboardStateItem else { return }
        do {
            let urlInfo = try dashboardUrlInfo()
            dashboardSetupURL = urlInfo.url
            dashboardFirstTimeSetup = urlInfo.firstTimeSetup
            dashboardLinkItem?.isHidden = !dashboardFirstTimeSetup
            dashboardLinkItem?.isEnabled = dashboardFirstTimeSetup
            let text = try mdb("status")
            guard let data = text.data(using: .utf8),
                  let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let dashboard = root["clientDashboard"] as? [String: Any] else { dashboardStateItem.title = "Dashboard: unavailable"; return }
            let running = dashboard["running"] as? Bool == true
            let port = dashboard["port"] as? Int ?? dashboardPort
            dashboardStateItem.title = dashboardFirstTimeSetup
                ? (running ? "Dashboard: running · first-time setup pending" : "Dashboard: stopped · first-time setup pending")
                : (running ? "Dashboard: running on 127.0.0.1:\(port)" : "Dashboard: stopped on 127.0.0.1:\(port)")
            if let clientServiceError { dashboardStateItem.title = "Service error: \(clientServiceError)" }
        } catch {
            dashboardSetupURL = URL(string: "http://127.0.0.1:\(dashboardPort)/")
            dashboardFirstTimeSetup = false
            dashboardLinkItem?.isHidden = true
            dashboardLinkItem?.isEnabled = false
            dashboardStateItem.title = "Dashboard: \(error.localizedDescription)"
        }
    }
    func dashboardUrlInfo() throws -> (url: URL?, firstTimeSetup: Bool) {
        let arguments = role == "server" ? ["--role", "server"] : []
        let text = try mdb("dashboard-url", extraArguments: arguments)
        guard let data = text.data(using: .utf8), let result = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = result["url"] as? String, let url = URL(string: value) else {
            throw NSError(domain: "Engram", code: 5, userInfo: [NSLocalizedDescriptionKey: "mdb service dashboard-url returned an invalid response"])
        }
        return (url, result["firstTimeSetup"] as? Bool == true)
    }
    func refreshServerDashboardStatus() {
        guard role == "server", let dashboardStateItem else { return }
        do {
            let info = try dashboardUrlInfo()
            dashboardSetupURL = info.url
            dashboardFirstTimeSetup = info.firstTimeSetup
            dashboardLinkItem?.isHidden = !info.firstTimeSetup
            dashboardLinkItem?.isEnabled = info.firstTimeSetup
            dashboardStateItem.title = info.firstTimeSetup ? "Dashboard: first-time setup pending" : "Dashboard: available on 127.0.0.1:\(info.url?.port ?? 4871)"
        } catch {
            dashboardSetupURL = URL(string: "http://127.0.0.1:4871/")
            dashboardFirstTimeSetup = false
            dashboardLinkItem?.isHidden = true
            dashboardLinkItem?.isEnabled = false
            dashboardStateItem.title = "Dashboard: \(error.localizedDescription)"
        }
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
    /// "Quit Engram Completely" stops the Dream worker along with the server worker. Opening the app must bring back every helper agent that is installed, or the nightly Dream run silently stops until the next login.
    func restoreHelperAgents() {
        guard role == "server" else { return }
        for name in ["dev.engram.intelligence-worker"] {
            let plist = agentDir.appendingPathComponent("\(name).plist")
            if files.fileExists(atPath: plist.path), launchctl(["print", "\(domain)/\(name)"]).0 != 0 { launchctl(["bootstrap", domain, plist.path]) }
        }
    }
    func startService() throws {
        restoreHelperAgents()
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
    @objc func startWorker() { do { if role == "client" { loadClientConfig(); guard clientReady else { throw NSError(domain: "Engram", code: 4, userInfo: [NSLocalizedDescriptionKey: "Set ENGRAM_MCP_URL and a mode-0600 ENGRAM_TOKEN_FILE in client.env"]) }; _ = try mdb("start"); clientServiceError = nil } else { try prepare(); try startService() } } catch { if role == "client" { clientServiceError = error.localizedDescription }; showError(error) }; if role == "client" { refreshVersion(); refreshClientServiceStatus() } else { refresh() } }
    @objc func stopWorker() {
        if role == "client" { do { _ = try mdb("stop") } catch { showError(error) }; stateItem.title = "Daemon stopped"; refreshClientServiceStatus(); return }
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
        if role == "client", let dashboardURL { NSWorkspace.shared.open(dashboardURL); return }
        do {
            let info = try dashboardUrlInfo()
            dashboardSetupURL = info.url
            dashboardFirstTimeSetup = info.firstTimeSetup
            dashboardLinkItem?.isHidden = !info.firstTimeSetup
            dashboardLinkItem?.isEnabled = info.firstTimeSetup
            if let url = info.url { NSWorkspace.shared.open(url) }
        } catch {
            dashboardStateItem?.title = "Dashboard: \(error.localizedDescription)"
            let port = role == "server" ? 4871 : dashboardPort
            if let url = URL(string: "http://127.0.0.1:\(port)/") { NSWorkspace.shared.open(url) }
        }
    }
    @objc func copyDashboardSetupLink() {
        guard dashboardFirstTimeSetup, let url = dashboardSetupURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }
    @objc func quit() { NSApp.terminate(nil) }
    /// Stops everything this app role runs, then quits the menu bar app. "Quit Menu Bar App" deliberately leaves the background service alone; this is the way to stop it all.
    /// Nothing is deleted or reconfigured, and a login item that is still enabled starts the app again at the next login.
    var launchdLabelsToStop: [String] {
        role == "client" ? [] : [label, "dev.engram.intelligence-worker", "dev.engram.tunnel-client", "dev.engram.keyed-gateway"]
    }
    @objc func quitCompletely() {
        if bootService {
            showError(NSError(domain: "Engram", code: 1, userInfo: [NSLocalizedDescriptionKey: "This service starts at system boot. Stop it with the supplied install-macos-boot.mjs uninstall command using sudo, then quit the menu bar app."]))
            return
        }
        let alert = NSAlert()
        alert.messageText = "Quit Engram \(role.capitalized) completely?"
        alert.informativeText = role == "client"
            ? "This stops the delivery daemon, the local dashboard and replica sync, then quits the menu bar app. Memory queued on this Mac waits until Engram starts again."
            : "This stops the server, its dashboard, the Dream worker and the ChatGPT tunnel, then quits the menu bar app. Other machines cannot reach this server until Engram starts again."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit Completely")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        timer?.invalidate()
        if role == "client" {
            do { _ = try mdb("stop") } catch { /* quit anyway: an already stopped daemon reports an error */ }
        } else {
            // Stop the tunnel and Dream worker first so nothing keeps calling the server while it goes down. The plists stay in place, so nothing is uninstalled.
            for name in launchdLabelsToStop.reversed() { launchctl(["bootout", "\(domain)/\(name)"]) }
            if files.fileExists(atPath: workerPlist.path) { try? files.removeItem(at: workerPlist) }
        }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = EngramApp()
app.delegate = delegate
app.run()
