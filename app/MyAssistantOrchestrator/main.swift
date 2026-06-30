import AppKit
import Foundation

class OrchestratorApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var timer: Timer?

    private let plistPath: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Library/LaunchAgents/com.myassistant.orchestrator.plist"
    }()

    private let projectRoot: String = {
        // Binary is at app/build/X.app/Contents/MacOS/X — walk up 6 levels to project root
        var url = Bundle.main.executableURL
        for _ in 0..<6 { url = url?.deletingLastPathComponent() }
        return url?.path ?? FileManager.default.currentDirectoryPath
    }()

    // Logs must live outside TCC-protected folders (e.g. ~/Desktop). A launchd
    // agent cannot open StandardOut/ErrorPath under ~/Desktop and fails to spawn
    // with EX_CONFIG (78) before node ever runs. ~/Library/Logs is unprotected.
    private let logDir: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Library/Logs/nanoclaw"
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Create a small utility window
        let windowRect = NSRect(x: 0, y: 0, width: 320, height: 220)
        window = NSWindow(
            contentRect: windowRect,
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "MyAssistant Orchestrator"
        window.center()
        window.isReleasedWhenClosed = false

        let contentView = NSView(frame: windowRect)

        // Status label
        statusLabel = NSTextField(labelWithString: "Checking...")
        statusLabel.frame = NSRect(x: 20, y: 170, width: 280, height: 24)
        statusLabel.font = NSFont.systemFont(ofSize: 16, weight: .medium)
        statusLabel.alignment = .center
        contentView.addSubview(statusLabel)

        // Buttons
        let startBtn = NSButton(title: "Start", target: self, action: #selector(startService))
        startBtn.frame = NSRect(x: 20, y: 120, width: 130, height: 32)
        startBtn.bezelStyle = .rounded
        startBtn.tag = 2
        contentView.addSubview(startBtn)

        let stopBtn = NSButton(title: "Stop", target: self, action: #selector(stopService))
        stopBtn.frame = NSRect(x: 170, y: 120, width: 130, height: 32)
        stopBtn.bezelStyle = .rounded
        stopBtn.tag = 3
        contentView.addSubview(stopBtn)

        let restartBtn = NSButton(title: "Restart", target: self, action: #selector(restartService))
        restartBtn.frame = NSRect(x: 20, y: 80, width: 280, height: 32)
        restartBtn.bezelStyle = .rounded
        restartBtn.tag = 4
        contentView.addSubview(restartBtn)

        let logsBtn = NSButton(title: "View Logs", target: self, action: #selector(viewLogs))
        logsBtn.frame = NSRect(x: 20, y: 40, width: 130, height: 32)
        logsBtn.bezelStyle = .rounded
        contentView.addSubview(logsBtn)

        let clearLogsBtn = NSButton(title: "Clear Logs", target: self, action: #selector(clearLogs))
        clearLogsBtn.frame = NSRect(x: 170, y: 40, width: 130, height: 32)
        clearLogsBtn.bezelStyle = .rounded
        contentView.addSubview(clearLogsBtn)

        window.contentView = contentView
        window.makeKeyAndOrderFront(nil)

        startStatusPolling()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    private func startStatusPolling() {
        updateStatus()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.updateStatus()
        }
    }

    private func updateStatus() {
        let running = isServiceRunning()
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if running {
                self.statusLabel.stringValue = "Status: Running"
                self.statusLabel.textColor = .systemGreen
            } else {
                self.statusLabel.stringValue = "Status: Stopped"
                self.statusLabel.textColor = .systemRed
            }
            self.window.contentView?.viewWithTag(2)?.isHidden = running
            self.window.contentView?.viewWithTag(3)?.isHidden = !running
            self.window.contentView?.viewWithTag(4)?.isHidden = !running
        }
    }

    private func isServiceRunning() -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["list", "com.myassistant.orchestrator"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus == 0
        } catch {
            return false
        }
    }

    @objc private func startService() {
        ensurePlist()
        runLaunchctl(["load", plistPath])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.updateStatus()
        }
    }

    @objc private func stopService() {
        runLaunchctl(["unload", plistPath])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.updateStatus()
        }
    }

    @objc private func restartService() {
        let uid = getuid()
        runLaunchctl(["kickstart", "-k", "gui/\(uid)/com.myassistant.orchestrator"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.updateStatus()
        }
    }

    @objc private func clearLogs() {
        let logPath = "\(logDir)/nanoclaw.log"
        let errorLogPath = "\(logDir)/nanoclaw.error.log"
        try? "".write(toFile: logPath, atomically: true, encoding: .utf8)
        try? "".write(toFile: errorLogPath, atomically: true, encoding: .utf8)
    }

    @objc private func viewLogs() {
        let logPath = "\(logDir)/nanoclaw.log"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-a", "Console", logPath]
        try? task.run()
    }

    private func runLaunchctl(_ args: [String]) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = args
        task.standardOutput = Pipe()
        task.standardError = Pipe()
        try? task.run()
        task.waitUntilExit()
    }

    private func ensurePlist() {
        let fm = FileManager.default
        guard !fm.fileExists(atPath: plistPath) else { return }

        let nodePath = findNode()
        try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)

        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>com.myassistant.orchestrator</string>
            <key>ProgramArguments</key>
            <array>
                <string>\(nodePath)</string>
                <string>\(projectRoot)/dist/index.js</string>
            </array>
            <key>WorkingDirectory</key>
            <string>\(projectRoot)</string>
            <key>RunAtLoad</key>
            <true/>
            <key>KeepAlive</key>
            <true/>
            <key>StandardOutPath</key>
            <string>\(logDir)/nanoclaw.log</string>
            <key>StandardErrorPath</key>
            <string>\(logDir)/nanoclaw.error.log</string>
            <key>EnvironmentVariables</key>
            <dict>
                <key>PATH</key>
                <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\(URL(fileURLWithPath: nodePath).deletingLastPathComponent().path)</string>
            </dict>
        </dict>
        </plist>
        """

        let dir = URL(fileURLWithPath: plistPath).deletingLastPathComponent().path
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? plist.write(toFile: plistPath, atomically: true, encoding: .utf8)
    }

    private func findNode() -> String {
        let candidates = [
            "\(FileManager.default.homeDirectoryForCurrentUser.path)/.nvm/versions/node/v22.22.0/bin/node",
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
        ]
        for path in candidates {
            if FileManager.default.fileExists(atPath: path) {
                return path
            }
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        task.arguments = ["node"]
        let pipe = Pipe()
        task.standardOutput = pipe
        try? task.run()
        task.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "/usr/local/bin/node"
        return output
    }
}

// --- Entry point ---
let app = NSApplication.shared
let delegate = OrchestratorApp()
app.delegate = delegate
app.run()
