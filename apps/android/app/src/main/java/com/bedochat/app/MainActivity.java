package com.bedochat.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * D-58: the website in the app's own web view. Unlike the earlier Trusted Web Activity (D-53), no browser is involved,
 * so there is never an address bar, whatever browser the phone has. The page reaches the app through the
 * "bedoAndroid" web message listener (offered to https://bedochat.com only, see apps/web/app/_lib/native-app.ts) for
 * notifications; everything else is the website itself.
 */
public final class MainActivity extends ComponentActivity {
    /** A page of the site to open (from a notification): a path such as "/?chat=…" or a full https://bedochat.com address. */
    static final String EXTRA_URL = "com.bedochat.app.URL";

    private static final String HOST = BuildConfig.SITE_HOST;
    private static final String ORIGIN = "https://" + HOST;

    private FrameLayout root;
    private WebView webView;
    private View splash;
    private View offline;
    private boolean loaded;
    private boolean mainFrameFailed;

    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private PermissionRequest pendingMedia;
    private final List<Runnable> afterNotificationAnswer = new ArrayList<>();

    private ActivityResultLauncher<Intent> fileLauncher;
    private ActivityResultLauncher<String[]> mediaPermissionLauncher;
    private ActivityResultLauncher<String> notificationPermissionLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Edge to edge (required from Android 15): the page sits between the status bar and the navigation bar, whose
        // areas show the page colour; the bars' icons follow the light or dark theme.
        EdgeToEdge.enable(this);
        Push.createChannel(this);
        registerLaunchers();

        root = new FrameLayout(this);
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.background));
        webView = new WebView(this);
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.background));
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        offline = buildOfflineView();
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            return WindowInsetsCompat.CONSUMED;
        });

        configureWebView();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                android.util.Log.d("BedoChat", "back: canGoBack=" + webView.canGoBack());
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    // Leave the app as Android does (keeps it in the recent apps, signed in).
                    moveTaskToBack(true);
                }
            }
        });

        String start = target(getIntent());
        webView.loadUrl(start != null ? start : ORIGIN + "/");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " BedoChatApp/Android");
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // The site has its own dark theme (prefers-color-scheme follows the app's theme): never darken it again.
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "bedoAndroid", Collections.singleton(ORIGIN), this::onPageMessage);
        }
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new ChromeClient());
        webView.setDownloadListener(this::download);
    }

    // ------------------------------------------------------------------------------------ Opening pages

    /** The site page an intent asks for (a notification's link or a bedochat.com link), or null. */
    private static String target(Intent intent) {
        if (intent == null) return null;
        String extra = intent.getStringExtra(EXTRA_URL);
        if (extra != null) {
            if (extra.startsWith("/")) return ORIGIN + extra;
            Uri uri = Uri.parse(extra);
            return isSite(uri) ? extra : null;
        }
        Uri data = intent.getData();
        return data != null && isSite(data) ? data.toString() : null;
    }

    private static boolean isSite(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost());
    }

    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = target(intent);
        if (url == null) return;
        if (loaded && webView.getUrl() != null && isSite(Uri.parse(webView.getUrl()))) {
            // The open app switches chat itself, as with a notification on the website (no reload).
            String detail = JSONObject.quote(url);
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('bedo-app-open', { detail: " + detail + " }))", null);
        } else {
            webView.loadUrl(url);
        }
    }

    // ------------------------------------------------------------------------------------ Messages from the page

    private void onPageMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin, boolean isMainFrame,
                               @NonNull JavaScriptReplyProxy reply) {
        if (!isMainFrame || !"https".equals(sourceOrigin.getScheme()) || !HOST.equals(sourceOrigin.getHost()) || message.getData() == null) return;
        final JSONObject request;
        try {
            request = new JSONObject(message.getData());
        } catch (JSONException error) {
            return;
        }
        final long id = request.optLong("id", -1);
        switch (request.optString("type")) {
            case "push-status":
                Push.status(this, status -> answer(reply, id, status));
                break;
            case "push-enable":
                askNotifications(() -> Push.status(this, status -> answer(reply, id, status)));
                break;
            case "badge":
                // Android shows the count of Bedo Chat's notifications on the icon by itself.
                answer(reply, id, Boolean.TRUE);
                break;
            case "open-settings":
                Push.openSettings(this);
                answer(reply, id, Boolean.TRUE);
                break;
            default:
                answerError(reply, id, "Unknown message");
        }
    }

    private void answer(JavaScriptReplyProxy reply, long id, Object result) {
        JSONObject answer = new JSONObject();
        try {
            answer.put("id", id);
            answer.put("result", result);
        } catch (JSONException ignored) {
            return;
        }
        runOnUiThread(() -> reply.postMessage(answer.toString()));
    }

    private void answerError(JavaScriptReplyProxy reply, long id, String error) {
        JSONObject answer = new JSONObject();
        try {
            answer.put("id", id);
            answer.put("error", error);
        } catch (JSONException ignored) {
            return;
        }
        runOnUiThread(() -> reply.postMessage(answer.toString()));
    }

    /** Android 13 and later: asks "Allow Bedo Chat to send you notifications?" when it still may; then goes on. */
    private void askNotifications(Runnable then) {
        if (Build.VERSION.SDK_INT < 33 || !"default".equals(Push.permission(this))) {
            then.run();
            return;
        }
        afterNotificationAnswer.add(then);
        if (afterNotificationAnswer.size() == 1) {
            Push.markAsked(this);
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
        }
    }

    // ------------------------------------------------------------------------------------ Results and permissions

    private void registerLaunchers() {
        notificationPermissionLauncher = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            List<Runnable> waiting = new ArrayList<>(afterNotificationAnswer);
            afterNotificationAnswer.clear();
            for (Runnable then : waiting) then.run();
        });
        mediaPermissionLauncher = registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), this::onMediaPermissions);
        fileLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            ValueCallback<Uri[]> callback = fileCallback;
            fileCallback = null;
            if (callback == null) return;
            Uri[] chosen = null;
            if (result.getResultCode() == RESULT_OK) {
                Intent data = result.getData();
                List<Uri> uris = new ArrayList<>();
                if (data != null && data.getClipData() != null) {
                    for (int index = 0; index < data.getClipData().getItemCount(); index++) uris.add(data.getClipData().getItemAt(index).getUri());
                } else if (data != null && data.getData() != null) {
                    uris.add(data.getData());
                } else if (cameraUri != null) {
                    uris.add(cameraUri); // A photo taken with the camera.
                }
                if (!uris.isEmpty()) chosen = uris.toArray(new Uri[0]);
            }
            cameraUri = null;
            callback.onReceiveValue(chosen);
        });
    }

    private void onMediaPermissions(Map<String, Boolean> answers) {
        PermissionRequest request = pendingMedia;
        pendingMedia = null;
        if (request == null) return;
        List<String> allowed = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = permissionFor(resource);
            if (permission != null && ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) allowed.add(resource);
        }
        if (allowed.isEmpty()) request.deny();
        else request.grant(allowed.toArray(new String[0]));
    }

    private static String permissionFor(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return Manifest.permission.CAMERA;
        return null;
    }

    // ------------------------------------------------------------------------------------ Files

    /** Saves a file the page downloads (a message's file: a signed storage link) to the phone's Downloads. */
    private void download(String url, String userAgent, String contentDisposition, String mimeType, long length) {
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme())) return; // blob: and data: addresses cannot be handed to Android.
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        if (Build.VERSION.SDK_INT < 29) {
            // Older Android needs a storage permission for Downloads: the phone's browser saves it instead.
            openOutside(uri);
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(uri)
                    .setMimeType(mimeType)
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(request);
            Toast.makeText(this, getString(R.string.downloading, name), Toast.LENGTH_SHORT).show();
        } catch (RuntimeException error) {
            openOutside(uri);
        }
    }

    private boolean chooseFiles(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        Intent pick = params.createIntent();
        if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        Intent chooser = Intent.createChooser(pick, getString(R.string.chooseFile));
        Intent camera = cameraIntent(params);
        if (camera != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
        try {
            fileLauncher.launch(chooser);
            return true;
        } catch (ActivityNotFoundException error) {
            fileCallback = null;
            cameraUri = null;
            return false;
        }
    }

    /** "Take a photo" next to the phone's file pickers, when the page accepts pictures and the camera may be used. */
    private Intent cameraIntent(WebChromeClient.FileChooserParams params) {
        boolean pictures = false;
        for (String type : params.getAcceptTypes()) {
            if (type == null || type.isEmpty() || type.startsWith("image/") || type.equals("*/*")) pictures = true;
        }
        if (params.getAcceptTypes().length == 0) pictures = true;
        if (!pictures || ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return null;
        Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (capture.resolveActivity(getPackageManager()) == null) return null;
        File folder = new File(getCacheDir(), "camera");
        if (!folder.exists() && !folder.mkdirs()) return null;
        File photo = new File(folder, "photo-" + System.currentTimeMillis() + ".jpg");
        cameraUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photo);
        capture.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
        capture.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return capture;
    }

    // ------------------------------------------------------------------------------------ Outside the site

    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.noApp, Toast.LENGTH_SHORT).show();
        }
    }

    /** The site stays in the app; files from storage download; every other address opens in its own app or browser. */
    private boolean stayInApp(Uri uri, boolean mainFrame) {
        if (!mainFrame) return true;
        String scheme = uri.getScheme();
        if (isSite(uri)) return true;
        // Signed links to the site's file storage: the web view answers them with a download (DownloadListener).
        return "https".equals(scheme) && uri.getHost() != null && uri.getHost().endsWith(".supabase.co");
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (stayInApp(uri, request.isForMainFrame())) return false;
            openOutside(uri);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            mainFrameFailed = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (mainFrameFailed) return;
            loaded = true;
            offline.setVisibility(View.GONE);
            hideSplash();
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            mainFrameFailed = true;
            loaded = false;
            offline.setVisibility(View.VISIBLE);
            hideSplash();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page's process ended (memory pressure in the background): start again rather than close the app.
            recreate();
            return true;
        }
    }

    private final class ChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            return chooseFiles(callback, params);
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            Uri origin = request.getOrigin();
            if (origin == null || !isSite(origin)) {
                request.deny();
                return;
            }
            List<String> missing = new ArrayList<>();
            for (String resource : request.getResources()) {
                String permission = permissionFor(resource);
                if (permission != null && ContextCompat.checkSelfPermission(MainActivity.this, permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
            }
            if (missing.isEmpty()) {
                onMediaPermissionsGranted(request);
                return;
            }
            if (pendingMedia != null) pendingMedia.deny();
            pendingMedia = request;
            mediaPermissionLauncher.launch(missing.toArray(new String[0]));
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingMedia == request) pendingMedia = null;
        }

        /** target="_blank" links: the site in the app, anything else outside. */
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            WebView probe = new WebView(MainActivity.this);
            probe.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if (isSite(uri)) webView.loadUrl(uri.toString());
                    else openOutside(uri);
                    probe.destroy();
                    return true;
                }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(probe);
            resultMsg.sendToTarget();
            return true;
        }
    }

    private void onMediaPermissionsGranted(PermissionRequest request) {
        List<String> allowed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (permissionFor(resource) != null) allowed.add(resource);
        }
        if (allowed.isEmpty()) request.deny();
        else request.grant(allowed.toArray(new String[0]));
    }

    // ------------------------------------------------------------------------------------ Start and offline screens

    /** The launch screen's icon stays until the first page has loaded, so there is no empty screen in between. */
    private View buildSplash() {
        ImageView image = new ImageView(this);
        image.setImageResource(R.drawable.splash);
        image.setScaleType(ImageView.ScaleType.CENTER);
        image.setBackgroundColor(ContextCompat.getColor(this, R.color.background));
        image.setClickable(true);
        return image;
    }

    private void hideSplash() {
        if (splash == null) return;
        View view = splash;
        splash = null;
        view.animate().alpha(0f).setDuration(250).withEndAction(() -> root.removeView(view)).start();
    }

    private View buildOfflineView() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setBackgroundColor(ContextCompat.getColor(this, R.color.background));
        int padding = dp(32);
        layout.setPadding(padding, padding, padding, padding);
        layout.setClickable(true);

        TextView title = new TextView(this);
        title.setText(R.string.offlineTitle);
        title.setTextColor(ContextCompat.getColor(this, R.color.text));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        layout.addView(title);

        TextView text = new TextView(this);
        text.setText(R.string.offlineText);
        text.setTextColor(ContextCompat.getColor(this, R.color.textSecondary));
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        text.setGravity(Gravity.CENTER);
        text.setPadding(0, dp(8), 0, dp(16));
        layout.addView(text);

        Button retry = new Button(this);
        retry.setText(R.string.tryAgain);
        retry.setOnClickListener(view -> {
            offline.setVisibility(View.GONE);
            String current = webView.getUrl();
            webView.loadUrl(current != null && isSite(Uri.parse(current)) ? current : ORIGIN + "/");
        });
        layout.addView(retry);
        return layout;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    // ------------------------------------------------------------------------------------ Lifecycle

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush(); // Keeps the sign-in if Android closes the app in the background.
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        root.removeView(webView);
        webView.destroy();
        super.onDestroy();
    }
}
