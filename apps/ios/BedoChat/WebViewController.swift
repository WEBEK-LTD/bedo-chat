import UIKit
import WebKit

/// Shows the website. The page talks to the app through the "bedo" message handler (window.webkit.messageHandlers.bedo,
/// see apps/web/app/_lib/native-app.ts); only pages from bedochat.com are answered.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    private var webView: WKWebView!
    private let offline = OfflineView()
    /// The launch screen (icon on its background) stays until the first page has loaded, so the app goes from the
    /// launch screen straight to the website instead of showing an empty white screen while it loads.
    private let splash = UIImageView(image: UIImage(named: "LaunchIcon"))
    private var loaded = false
    private var pendingPath: String?

    /// The website's own background colours (light and dark, D-48), behind the status bar and home indicator.
    private static let background = UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 0x13 / 255, green: 0x1C / 255, blue: 0x27 / 255, alpha: 1) : .white
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default() // keeps the sign-in, like the website
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.applicationNameForUserAgent = "Mobile/15E148 BedoChatApp"
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bedo")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        offline.translatesAutoresizingMaskIntoConstraints = false
        offline.isHidden = true
        offline.onRetry = { [weak self] in self?.reload() }
        view.addSubview(offline)

        splash.contentMode = .center
        splash.backgroundColor = UIColor(named: "LaunchBackground") ?? Self.background
        splash.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(splash)

        // Edge to edge: the website keeps its content inside the safe area and WebKit fills the status bar and home
        // indicator areas with the page's own background colour (sign-in page, chats, light or dark).
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            offline.topAnchor.constraint(equalTo: view.topAnchor),
            offline.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            offline.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            offline.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            splash.topAnchor.constraint(equalTo: view.topAnchor),
            splash.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            splash.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            splash.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        webView.load(URLRequest(url: Site.url(path: pendingPath ?? "/")))
        pendingPath = nil
    }

    /// Opens a page of the site: the open app switches chat itself (as with a notification on the website).
    func open(path: String) {
        guard isViewLoaded, webView != nil else {
            pendingPath = path
            return
        }
        let url = Site.url(path: path)
        if loaded, webView.url?.host == Site.host, let json = try? JSONSerialization.data(withJSONObject: [url.absoluteString]), let list = String(data: json, encoding: .utf8) {
            webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('bedo-app-open', { detail: \(list)[0] }))")
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    private func reload() {
        offline.isHidden = true
        webView.load(URLRequest(url: webView.url ?? Site.origin))
    }

    // MARK: - Messages from the page

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "https", message.frameInfo.securityOrigin.host == Site.host else {
            replyHandler(nil, "Not allowed")
            return
        }
        let body = message.body as? [String: Any] ?? [:]
        switch body["type"] as? String {
        case "push-status":
            Push.shared.status { replyHandler($0, nil) }
        case "push-enable":
            Push.shared.enable { replyHandler($0, nil) }
        case "badge":
            Push.shared.setBadge((body["count"] as? NSNumber)?.intValue ?? 0)
            replyHandler(true, nil)
        case "open-settings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            replyHandler(true, nil)
        default:
            replyHandler(nil, "Unknown message")
        }
    }

    // MARK: - Navigation: bedochat.com stays in the app, other addresses open in Safari

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if url.scheme == "https", url.host == Site.host || !mainFrame {
            decisionHandler(.allow)
            return
        }
        if ["about", "blob", "data"].contains(url.scheme ?? "") {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated || ["mailto", "tel", "sms", "https", "http"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    /// Links that open a new window (target="_blank"): the site in the app, anything else in Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if url.host == Site.host { webView.load(URLRequest(url: url)) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    /// Camera and microphone for voice and video messages: iOS asks the person once for the app.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == Site.host ? .prompt : .deny)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        offline.isHidden = true
        hideSplash()
    }

    private func hideSplash() {
        guard splash.superview != nil else { return }
        UIView.animate(withDuration: 0.25, animations: { self.splash.alpha = 0 }, completion: { _ in self.splash.removeFromSuperview() })
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOffline(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showOffline(error)
    }

    /// The page's process ended (memory pressure in the background): load it again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
    }

    private func showOffline(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        loaded = false
        offline.isHidden = false
        hideSplash()
    }

    // MARK: - JavaScript dialogs (confirm before deleting, etc.)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}

/// Shown when bedochat.com cannot be reached.
final class OfflineView: UIView {
    var onRetry: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground
        let icon = UIImageView(image: UIImage(systemName: "wifi.slash"))
        icon.tintColor = .secondaryLabel
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 40)
        let title = UILabel()
        title.text = "Can't reach Bedo Chat"
        title.font = .preferredFont(forTextStyle: .headline)
        let text = UILabel()
        text.text = "Check your internet connection and try again."
        text.font = .preferredFont(forTextStyle: .subheadline)
        text.textColor = .secondaryLabel
        text.numberOfLines = 0
        text.textAlignment = .center
        var button = UIButton.Configuration.filled()
        button.title = "Try again"
        let retry = UIButton(configuration: button, primaryAction: UIAction { [weak self] _ in self?.onRetry?() })
        let stack = UIStackView(arrangedSubviews: [icon, title, text, retry])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -32),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }
}
