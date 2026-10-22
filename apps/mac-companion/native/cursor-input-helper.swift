import AppKit
import ApplicationServices
import Foundation

private let cursorBundleIdentifier = "com.todesktop.230313mzl4w4u92"

private enum HelperError: Error, CustomStringConvertible {
    case accessibilityDenied
    case cursorNotRunning
    case cursorNotFrontmost
    case invalidCommand

    var description: String {
        switch self {
        case .accessibilityDenied:
            return "macOS 辅助功能权限尚未授予"
        case .cursorNotRunning:
            return "Cursor 尚未启动"
        case .cursorNotFrontmost:
            return "输入前台校验失败：当前前台应用不是 Cursor"
        case .invalidCommand:
            return "无效的输入辅助命令"
        }
    }
}

private func accessibilityTrusted(prompt: Bool) -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

private func copyAttribute<T>(_ element: AXUIElement, _ attribute: CFString, as _: T.Type) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? T
}

private func windowFrame(_ window: AXUIElement) -> (CGPoint, CGSize)? {
    guard
        let positionValue = copyAttribute(window, kAXPositionAttribute as CFString, as: AXValue.self),
        let sizeValue = copyAttribute(window, kAXSizeAttribute as CFString, as: AXValue.self)
    else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard
        AXValueGetValue(positionValue, .cgPoint, &position),
        AXValueGetValue(sizeValue, .cgSize, &size)
    else { return nil }
    return (position, size)
}

private func cursorApplication() throws -> NSRunningApplication {
    guard let application = NSRunningApplication.runningApplications(withBundleIdentifier: cursorBundleIdentifier).first else {
        throw HelperError.cursorNotRunning
    }
    return application
}

private func activateCursor(workspaceName: String) throws {
    guard accessibilityTrusted(prompt: false) else { throw HelperError.accessibilityDenied }
    let application = try cursorApplication()
    application.activate(options: [.activateAllWindows])
    usleep(180_000)

    let appElement = AXUIElementCreateApplication(application.processIdentifier)
    guard let windows = copyAttribute(appElement, kAXWindowsAttribute as CFString, as: [AXUIElement].self), !windows.isEmpty else {
        return
    }
    let target = workspaceName.isEmpty ? windows.first : windows.first { window in
        let title = copyAttribute(window, kAXTitleAttribute as CFString, as: String.self) ?? ""
        return title.localizedCaseInsensitiveContains(workspaceName)
    }
    guard let target else { return }
    AXUIElementPerformAction(target, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(target, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(100_000)
}

private func openCursorIDE(workspaceName: String) throws {
    guard accessibilityTrusted(prompt: false) else { throw HelperError.accessibilityDenied }
    let application = try cursorApplication()
    application.activate(options: [.activateAllWindows])
    usleep(180_000)
    let appElement = AXUIElementCreateApplication(application.processIdentifier)
    guard let windows = copyAttribute(appElement, kAXWindowsAttribute as CFString, as: [AXUIElement].self) else { return }

    if let workspaceWindow = windows.first(where: { window in
        let title = copyAttribute(window, kAXTitleAttribute as CFString, as: String.self) ?? ""
        return !workspaceName.isEmpty
            && title.localizedCaseInsensitiveContains(workspaceName)
            && !title.localizedCaseInsensitiveContains("Cursor Agents")
    }) {
        AXUIElementPerformAction(workspaceWindow, kAXRaiseAction as CFString)
        return
    }

    guard let agentsWindow = windows.first(where: { window in
        let title = copyAttribute(window, kAXTitleAttribute as CFString, as: String.self) ?? ""
        return title.localizedCaseInsensitiveContains("Cursor Agents")
    }), let (position, size) = windowFrame(agentsWindow) else { return }
    AXUIElementPerformAction(agentsWindow, kAXRaiseAction as CFString)
    usleep(100_000)
    let clickPoint = CGPoint(x: position.x + size.width - 90, y: position.y + 28)
    let source = CGEventSource(stateID: .combinedSessionState)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: clickPoint, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: clickPoint, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: clickPoint, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(250_000)
}

private func postUnicodeText(_ text: String) {
    let source = CGEventSource(stateID: .combinedSessionState)
    let codeUnits = Array(text.utf16)
    let chunkSize = 32
    var offset = 0
    while offset < codeUnits.count {
        var chunk = Array(codeUnits[offset..<min(offset + chunkSize, codeUnits.count)])
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        chunk.withUnsafeMutableBufferPointer { pointer in
            keyDown?.keyboardSetUnicodeString(stringLength: pointer.count, unicodeString: pointer.baseAddress)
            keyUp?.keyboardSetUnicodeString(stringLength: pointer.count, unicodeString: pointer.baseAddress)
        }
        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)
        offset += chunk.count
        usleep(4_000)
    }
}

private func submitText() throws {
    guard accessibilityTrusted(prompt: false) else { throw HelperError.accessibilityDenied }
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == cursorBundleIdentifier else {
        throw HelperError.cursorNotFrontmost
    }
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let text = String(data: data, encoding: .utf8), !text.isEmpty else { return }
    postUnicodeText(text)
    usleep(60_000)
    let source = CGEventSource(stateID: .combinedSessionState)
    CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false)?.post(tap: .cghidEventTap)
}

do {
    guard CommandLine.arguments.count >= 2 else { throw HelperError.invalidCommand }
    switch CommandLine.arguments[1] {
    case "trust":
        let prompt = CommandLine.arguments.contains("--prompt")
        if accessibilityTrusted(prompt: prompt) {
            print("trusted")
        } else {
            print("not-trusted")
            exit(2)
        }
    case "activate":
        let workspaceName = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : ""
        try activateCursor(workspaceName: workspaceName)
        print("activated")
    case "open-ide":
        let workspaceName = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : ""
        try openCursorIDE(workspaceName: workspaceName)
        print("opened")
    case "submit":
        try submitText()
        print("submitted")
    default:
        throw HelperError.invalidCommand
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
