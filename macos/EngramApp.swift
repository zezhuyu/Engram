import AppKit

// The menu bar process controls a separate launchd worker. Closing this UI never owns its lifetime.
final class EngramApp: NSObject, NSApplicationDelegate {
    let role = Bundle.main.object(forInfoDictionaryKey: "EngramRole") as? String ?? "server"
    var item: NSStatusItem!
    var startupItem: NSMenuItem!
    var stateItem: NSMenuItem!
    var timer: Timer?
    let files = FileManager.default
    var home: URL { files.homeDirectoryForCurrentUser }
    var label: String { "org.engram.\(role).worker" }
    var appLabel: String { "org.engram.\(role).app" }
    var domain: String { "gui/\(getuid())" }
    var agentDir: URL { home.appendingPathComponent("Library/LaunchAgents") }
    var workerPlist: URL { agentDir.appendingPathComponent("\(label).plist") }
    var appPlist: URL { agentDir.appendingPathComponent("\(appLabel).plist") }
    var config: URL { home.appendingPathComponent(".config/engram/\(role).env") }
    var log: URL { home.appendingPathComponent("Library/Logs/Engram/\(role).log") }
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
        item.button?.toolTip = "Engram \(role.capitalized)"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Engram \(role.capitalized)", action: nil, keyEquivalent: ""))
        stateItem = NSMenuItem(title: "Background service", action: nil, keyEquivalent: "")
        menu.addItem(stateItem)
        menu.addItem(.separator())
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
                ? "# Configure an authorized remote endpoint and scoped credential.\nENGRAM_MCP_URL=\nENGRAM_MCP_TOKEN=\n# Optional: ENGRAM_WORKSPACE, ENGRAM_PROJECT_DIR, ENGRAM_OUTBOX\n"
                : "# Server defaults to loopback. Configure HTTPS ingress and scoped auth for remote access.\nMDB_MCP_HTTP_HOST=127.0.0.1\nMDB_MCP_HTTP_PORT=3333\n# ENGRAM_DATA_DIR and authentication options can also be set here.\n"
            try text.write(to: config, atomically: true, encoding: .utf8)
            try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
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
    @objc func startWorker() { do { try prepare(); try startService() } catch { showError(error) }; refresh() }
    @objc func stopWorker() {
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
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = EngramApp()
app.delegate = delegate
app.run()
