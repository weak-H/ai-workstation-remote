import AppKit
import CoreImage
import Foundation

private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var statusDot: NSTextField!
    private var statusLabel: NSTextField!
    private var qrImage: NSImageView!
    private var copyButton: NSButton!
    private var restartButton: NSButton!
    private var logView: NSTextView!
    private var service: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var stdoutBuffer = ""
    private var remoteURL: URL?
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startService()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        stopService()
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = NSFont.systemFont(ofSize: size, weight: weight)
        field.textColor = .labelColor
        field.maximumNumberOfLines = 0
        return field
    }

    private func button(_ title: String, symbolName: String, action: Selector, primary: Bool = false) -> NSButton {
        let control = NSButton(title: title, target: self, action: action)
        control.bezelStyle = .rounded
        control.controlSize = .large
        control.font = .systemFont(ofSize: 13, weight: .medium)
        control.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: title)
        control.imagePosition = .imageLeading
        control.imageHugsTitle = true
        if primary {
            control.bezelColor = .systemGreen
            control.contentTintColor = .white
        }
        return control
    }

    private func surface(fillColor: NSColor = .controlBackgroundColor, radius: CGFloat = 10) -> NSBox {
        let box = NSBox()
        box.boxType = .custom
        box.titlePosition = .noTitle
        box.borderColor = .separatorColor
        box.borderWidth = 1
        box.cornerRadius = radius
        box.fillColor = fillColor
        return box
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 730),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AI Workstation Remote"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.center()
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 600, height: 680)
        window.backgroundColor = .windowBackgroundColor

        let content = NSView()
        window.contentView = content

        let titleRow = NSStackView()
        titleRow.orientation = .horizontal
        titleRow.spacing = 12
        titleRow.alignment = .centerY
        let symbol = NSImageView(image: NSImage(systemSymbolName: "network", accessibilityDescription: "AI Workstation Remote") ?? NSImage())
        symbol.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 21, weight: .semibold)
        symbol.contentTintColor = .white
        symbol.translatesAutoresizingMaskIntoConstraints = false
        let symbolSurface = surface(fillColor: .systemGreen, radius: 10)
        symbolSurface.borderWidth = 0
        symbolSurface.translatesAutoresizingMaskIntoConstraints = false
        symbolSurface.addSubview(symbol)
        NSLayoutConstraint.activate([
            symbolSurface.widthAnchor.constraint(equalToConstant: 42),
            symbolSurface.heightAnchor.constraint(equalToConstant: 42),
            symbol.centerXAnchor.constraint(equalTo: symbolSurface.centerXAnchor),
            symbol.centerYAnchor.constraint(equalTo: symbolSurface.centerYAnchor),
            symbol.widthAnchor.constraint(equalToConstant: 24),
            symbol.heightAnchor.constraint(equalToConstant: 24),
        ])
        let heading = label("AI Workstation Remote", size: 24, weight: .semibold)
        let subtitle = label("连接这台 Mac 与其他终端", size: 13)
        subtitle.textColor = .secondaryLabelColor
        let headingStack = NSStackView(views: [heading, subtitle])
        headingStack.orientation = .vertical
        headingStack.spacing = 3
        headingStack.alignment = .leading
        titleRow.addArrangedSubview(symbolSurface)
        titleRow.addArrangedSubview(headingStack)

        statusDot = label("●", size: 14, weight: .bold)
        statusDot.textColor = .systemOrange
        statusLabel = label("正在启动本地服务…", size: 14, weight: .medium)
        let statusRow = NSStackView(views: [statusDot, statusLabel])
        statusRow.orientation = .horizontal
        statusRow.spacing = 8
        statusRow.alignment = .centerY
        let statusSurface = surface()
        statusSurface.translatesAutoresizingMaskIntoConstraints = false
        statusSurface.addSubview(statusRow)
        statusRow.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            statusSurface.heightAnchor.constraint(equalToConstant: 44),
            statusRow.leadingAnchor.constraint(equalTo: statusSurface.leadingAnchor, constant: 14),
            statusRow.trailingAnchor.constraint(lessThanOrEqualTo: statusSurface.trailingAnchor, constant: -14),
            statusRow.centerYAnchor.constraint(equalTo: statusSurface.centerYAnchor),
        ])

        let accessTitle = label("远程访问", size: 15, weight: .semibold)
        let accessHint = label("扫描二维码，或复制链接到其他终端打开", size: 12)
        accessHint.textColor = .secondaryLabelColor
        let accessHeader = NSStackView(views: [accessTitle, accessHint])
        accessHeader.orientation = .vertical
        accessHeader.spacing = 3
        accessHeader.alignment = .leading

        qrImage = NSImageView()
        qrImage.imageScaling = .scaleProportionallyUpOrDown
        qrImage.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            qrImage.widthAnchor.constraint(equalToConstant: 236),
            qrImage.heightAnchor.constraint(equalToConstant: 236),
        ])
        let qrPlaceholder = NSImage(systemSymbolName: "qrcode", accessibilityDescription: "远程访问二维码")
        qrImage.image = qrPlaceholder
        qrImage.contentTintColor = .tertiaryLabelColor

        let qrSurface = surface(fillColor: .white, radius: 12)
        qrSurface.translatesAutoresizingMaskIntoConstraints = false
        qrSurface.addSubview(qrImage)
        NSLayoutConstraint.activate([
            qrSurface.widthAnchor.constraint(equalToConstant: 268),
            qrSurface.heightAnchor.constraint(equalToConstant: 268),
            qrImage.centerXAnchor.constraint(equalTo: qrSurface.centerXAnchor),
            qrImage.centerYAnchor.constraint(equalTo: qrSurface.centerYAnchor),
        ])

        copyButton = button("复制访问链接", symbolName: "doc.on.doc", action: #selector(copyRemoteLink), primary: true)
        copyButton.isEnabled = false
        restartButton = button("重新启动服务", symbolName: "arrow.clockwise", action: #selector(restartService))
        let actionButtons = NSStackView(views: [copyButton, restartButton])
        actionButtons.orientation = .horizontal
        actionButtons.spacing = 10
        actionButtons.distribution = .fillEqually

        let logTitle = label("运行日志", size: 13, weight: .semibold)
        let logState = label("实时输出", size: 11)
        logState.textColor = .tertiaryLabelColor
        let logHeader = NSStackView(views: [logTitle, NSView(), logState])
        logHeader.orientation = .horizontal
        logHeader.alignment = .centerY
        logView = NSTextView(frame: NSRect(x: 0, y: 0, width: 520, height: 145))
        logView.isEditable = false
        logView.isSelectable = true
        logView.isVerticallyResizable = true
        logView.isHorizontallyResizable = false
        logView.autoresizingMask = [.width]
        logView.minSize = NSSize(width: 0, height: 0)
        logView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        logView.textContainer?.containerSize = NSSize(width: 520, height: CGFloat.greatestFiniteMagnitude)
        logView.textContainer?.widthTracksTextView = true
        logView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        logView.textColor = .secondaryLabelColor
        logView.backgroundColor = .textBackgroundColor
        logView.textContainerInset = NSSize(width: 8, height: 8)
        let scroll = NSScrollView()
        scroll.documentView = logView
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 8
        scroll.layer?.borderWidth = 1
        scroll.layer?.borderColor = NSColor.separatorColor.cgColor
        scroll.layer?.masksToBounds = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 130).isActive = true

        let stack = NSStackView(views: [
            titleRow,
            statusSurface,
            accessHeader,
            qrSurface,
            actionButtons,
            logHeader,
            scroll,
        ])
        stack.orientation = .vertical
        stack.spacing = 12
        stack.alignment = .leading
        stack.setCustomSpacing(20, after: titleRow)
        stack.setCustomSpacing(18, after: statusSurface)
        stack.setCustomSpacing(8, after: accessHeader)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -32),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -26),
            statusSurface.widthAnchor.constraint(equalTo: stack.widthAnchor),
            qrSurface.centerXAnchor.constraint(equalTo: stack.centerXAnchor),
            actionButtons.widthAnchor.constraint(equalTo: stack.widthAnchor),
            logHeader.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    private func setStatus(_ text: String, color: NSColor) {
        statusLabel.stringValue = text
        statusDot.textColor = color
    }

    private func appendLog(_ text: String) {
        guard !text.isEmpty else { return }
        logView.textStorage?.append(NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]))
        if let storage = logView.textStorage, storage.length > 60_000 {
            storage.deleteCharacters(in: NSRange(location: 0, length: storage.length - 50_000))
        }
        logView.scrollToEndOfDocument(nil)
    }

    private func consumeStdout(_ text: String) {
        appendLog(text)
        stdoutBuffer += text
        while let newline = stdoutBuffer.firstIndex(of: "\n") {
            let line = String(stdoutBuffer[..<newline])
            stdoutBuffer.removeSubrange(...newline)
            if line.hasPrefix("AI_WORKSTATION_LOCAL_URL="),
               URL(string: String(line.dropFirst("AI_WORKSTATION_LOCAL_URL=".count))) != nil {
                setStatus("本地服务已启动，正在建立远程访问…", color: .systemOrange)
            }
            if line.hasPrefix("AI_WORKSTATION_ACCESS_URL="),
               let url = URL(string: String(line.dropFirst("AI_WORKSTATION_ACCESS_URL=".count))) {
                remoteURL = url
                qrImage.image = qrCode(for: url.absoluteString)
                copyButton.isEnabled = true
                setStatus("远程访问已就绪", color: .systemGreen)
            }
        }
    }

    private func qrCode(for value: String) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(value.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return nil }
        let representation = NSCIImageRep(ciImage: output)
        let image = NSImage(size: representation.size)
        image.addRepresentation(representation)
        return image
    }

    private func startService() {
        guard service?.isRunning != true else { return }
        remoteURL = nil
        copyButton.isEnabled = false
        restartButton.isEnabled = false
        qrImage.image = NSImage(systemSymbolName: "qrcode", accessibilityDescription: "远程访问二维码")
        setStatus("正在启动本地服务…", color: .systemOrange)
        appendLog("[app] 正在启动本地服务…\n")

        guard let resources = Bundle.main.resourceURL else {
            setStatus("无法定位应用资源", color: .systemRed)
            return
        }
        let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
        let node = resources.appendingPathComponent("runtime/bin/node")
        let supervisor = resources.appendingPathComponent("app/start-packaged.mjs")
        let cloudflared = contents.appendingPathComponent("Helpers/cloudflared")
        let inputHelper = contents.appendingPathComponent("Helpers/cursor-input-helper")

        let process = Process()
        process.executableURL = node
        process.arguments = [supervisor.path]
        process.currentDirectoryURL = resources.appendingPathComponent("app")
        var environment = ProcessInfo.processInfo.environment
        environment["CLOUDFLARED_BIN"] = cloudflared.path
        environment["CURSOR_INPUT_HELPER"] = inputHelper.path
        environment["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment

        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        stdoutPipe = output
        stderrPipe = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.consumeStdout(text) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.appendLog(text) }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self else { return }
                self.restartButton.isEnabled = true
                if !self.quitting {
                    self.setStatus("服务已停止（退出码 \(process.terminationStatus)）", color: .systemRed)
                }
            }
        }

        do {
            try process.run()
            service = process
            restartButton.isEnabled = true
        } catch {
            appendLog("启动失败：\(error.localizedDescription)\n")
            setStatus("服务启动失败", color: .systemRed)
            restartButton.isEnabled = true
        }
    }

    private func stopService() {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        if let service, service.isRunning {
            service.terminate()
        }
        self.service = nil
    }

    @objc private func copyRemoteLink() {
        guard let remoteURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(remoteURL.absoluteString, forType: .string)
        setStatus("访问链接已复制", color: .systemGreen)
    }

    @objc private func restartService() {
        stopService()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.startService() }
    }
}

let application = NSApplication.shared
private let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
