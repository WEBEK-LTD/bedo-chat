import UIKit
import UserNotifications

/// The app's notification permission and its Apple device address, which the page saves with the user's session
/// (D-53): https://api.push.apple.com/3/device/<token>, or the sandbox address for a development build.
final class Push {
    static let shared = Push()

    private var endpoint: String?
    private var waiting: [() -> Void] = []

    private static var host: String {
        #if DEBUG
        return "api.sandbox.push.apple.com"
        #else
        return "api.push.apple.com"
        #endif
    }

    /// On every start: when notifications are allowed, ask Apple for the (possibly new) device address.
    func refreshIfAllowed() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard Push.allowed(settings.authorizationStatus) else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /// The permission and address, registering first when allowed but not yet registered.
    func status(_ reply: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                let status = settings.authorizationStatus
                if Push.allowed(status) {
                    self.register { reply(self.answer(permission: "granted")) }
                } else {
                    reply(self.answer(permission: status == .denied ? "denied" : "default"))
                }
            }
        }
    }

    /// Asks iOS once (later answers come from Settings), then registers.
    func enable(_ reply: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            self.status(reply)
        }
    }

    func registered(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        endpoint = "https://\(Push.host)/3/device/\(hex)"
        flush()
    }

    func failed() {
        flush()
    }

    func setBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(max(0, count)) { _ in }
    }

    private func register(_ done: @escaping () -> Void) {
        if endpoint != nil {
            done()
            return
        }
        waiting.append(done)
        UIApplication.shared.registerForRemoteNotifications()
        // Without a network Apple may not answer: the page is answered anyway and tries again next start.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { self.flush() }
    }

    private func flush() {
        DispatchQueue.main.async {
            let callbacks = self.waiting
            self.waiting = []
            callbacks.forEach { $0() }
        }
    }

    private func answer(permission: String) -> [String: Any] {
        var answer: [String: Any] = ["permission": permission]
        if permission == "granted", let endpoint { answer["endpoint"] = endpoint }
        return answer
    }

    private static func allowed(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }
}
