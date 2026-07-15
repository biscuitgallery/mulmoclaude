import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let toggleItem = NSMenuItem()
    private let warningItem = NSMenuItem()
    /// Only restore normal sleep on quit when this app was the one that disabled it.
    private var enabledByApp = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.menu = buildMenu()
        refreshUI(sleepDisabled: SleepControl.isSleepDisabled())
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard enabledByApp, SleepControl.isSleepDisabled() else { return }
        _ = SleepControl.setSleepDisabled(false)
    }

    // Re-sync with the real pmset state every time the menu opens, in case it
    // was changed from Terminal or another tool while we were idle.
    func menuWillOpen(_ menu: NSMenu) {
        refreshUI(sleepDisabled: SleepControl.isSleepDisabled())
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self

        toggleItem.title = L10n.toggleTitle
        toggleItem.target = self
        toggleItem.action = #selector(toggleSleep)
        menu.addItem(toggleItem)

        warningItem.title = L10n.batteryWarning
        warningItem.isEnabled = false
        menu.addItem(warningItem)

        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: L10n.quitTitle, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quitItem)
        return menu
    }

    @objc private func toggleSleep() {
        let target = !SleepControl.isSleepDisabled()
        switch SleepControl.setSleepDisabled(target) {
        case .success:
            enabledByApp = target
            refreshUI(sleepDisabled: target)
        case .failure(.cancelled):
            refreshUI(sleepDisabled: SleepControl.isSleepDisabled())
        case .failure(.scriptFailure(let message)):
            showError(message)
            refreshUI(sleepDisabled: SleepControl.isSleepDisabled())
        }
    }

    private func refreshUI(sleepDisabled: Bool) {
        toggleItem.state = sleepDisabled ? .on : .off
        warningItem.isHidden = !sleepDisabled
        updateStatusIcon(active: sleepDisabled)
    }

    private func updateStatusIcon(active: Bool) {
        guard let button = statusItem.button else { return }
        let symbolName = active ? "cup.and.saucer.fill" : "cup.and.saucer"
        if let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: L10n.toggleTitle) {
            button.image = image
            button.title = ""
        } else {
            button.image = nil
            button.title = active ? "☕️" : "💤"
        }
        button.toolTip = L10n.toggleTitle
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n.errorTitle
        alert.informativeText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}
