import UIKit
import UserNotifications

/// Bedo Chat for iPhone (D-53): shows https://bedochat.com and receives its notifications through Apple (APNs).
@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?
    private let web = WebViewController()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = web
        window.makeKeyAndVisible()
        self.window = window
        Push.shared.refreshIfAllowed()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.shared.registered(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Push.shared.failed()
    }

    /// A link to bedochat.com opened from another app (an invite link, say).
    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL, url.host == Site.host else { return false }
        web.open(path: url.path + (url.query.map { "?\($0)" } ?? ""))
        return true
    }

    /// While the app is open, notifications still show, as on the website.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    /// Tapping a notification opens its chat.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let path = response.notification.request.content.userInfo["url"] as? String ?? "/"
        web.open(path: path)
        completionHandler()
    }
}

enum Site {
    static let host = "bedochat.com"
    static let origin = URL(string: "https://bedochat.com")!

    /// A path on the site ("/?chat=..."), never another address.
    static func url(path: String) -> URL {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: path, relativeTo: origin)?.absoluteURL, url.host == host else {
            return origin
        }
        return url
    }
}
