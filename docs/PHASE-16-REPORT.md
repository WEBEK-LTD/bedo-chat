# Phase 16 — Android and iPhone apps that open the website (D-53)

Owner's request of 2026-10-10: apps for Android and iPhone that read from the website, in the same project, with no
database change, and notifications that arrive. Setup steps for the owner: [`docs/APPS.md`](APPS.md).

## What was built

| Part | Where | What it does |
| --- | --- | --- |
| Android app | `apps/android` | Trusted Web Activity (Android Browser Helper 2.5.0): opens https://bedochat.com full screen in the phone's Chrome engine; splash screen; the website's Web Push notifications show as the app's own (delegation service, Bedo Chat notification icon); Android 13+ notification permission; links to bedochat.com open in the app. App ID `com.bedochat.app`, target SDK 36, min SDK 23 |
| Site link for Android | `apps/web/public/.well-known/assetlinks.json` | Proves the site and the app belong together, so Android shows no address bar. Holds the upload key's fingerprint; Google Play's app signing fingerprint is added after the first upload (APPS.md A3.3) |
| iPhone app | `apps/ios` | WKWebView of https://bedochat.com, edge to edge, sign-in kept; registers with Apple (APNs) and gives the page its device address; notification tap opens the chat (switching chat in the open app without a reload); app icon badge from the website's unread count; links to other sites open in Safari; camera and microphone for voice and video messages; a "Can't reach Bedo Chat" page with Try again. XcodeGen project (`project.yml`), iOS 16+ |
| Page ↔ iPhone app | `apps/web/app/_lib/native-app.ts`, `push.ts`, `chat-shell.tsx`, `notifications-panel.tsx` | Inside the iPhone app the page asks the app (message handler `bedo`, answered only for https://bedochat.com) for permission and its address, saves it with the existing `PUT /v1/me/push-subscription`, refreshes it on each start, and sets the badge. Settings → Notifications works as on the website; "blocked" shows **Open Settings**. In browsers and the Android app nothing changes |
| API: Apple notifications | `apps/api/src/delivery/apns.ts`, `push.service.ts` | Addresses `https://api.push.apple.com/3/device/<token>` (already an allowed push-service address, stored in the existing `app.push_subscriptions`) go to APNs over HTTP/2 with an ES256 provider token (kept 45 minutes): same title, text, chat grouping (collapse ID and thread), badge and link as Web Push. Apple's `Unregistered` / `BadDeviceToken` / `DeviceTokenNotForTopic` remove the address like a browser's 404/410 |
| Configuration | `packages/config` | Optional `APNS_KEY` (secret), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` (default `com.bedochat.app`). Missing or unreadable: iPhone notifications off, logged; the site keeps working |
| Builds | `.github/workflows/apps.yml` | On upload (when the apps change) or Run workflow: Android signed `.aab` + `.apk` with the upload key from GitHub secrets (unsigned test `.apk` without them), checked (every library class the manifest names is in the app, notification permission present, version and signing fingerprint printed); iPhone archive uploaded to TestFlight with an App Store Connect API key (simulator build without it) |

No table, column or SQL: the database is untouched.

## Verification

* API unit tests (`apps/api/test/apns.test.ts`, against a local HTTP/2 server): which addresses are Apple device
  addresses; the `.p8` key read however it is pasted; headers, payload, collapse ID and a provider token verified
  with the key's public half and reused; "device gone" answers reported as 410 and others kept; nothing sent and no
  failure when the key is missing or wrong.
* Integration test (real Postgres): an iPhone address saved through `PUT /v1/me/push-subscription` receives the same
  notification as a browser, and is removed when Apple reports it gone.
* Full project checks: lint, typecheck, unit, integration, Netlify build and deploy checks pass; browser end-to-end
  86 of 87. The other one (`browser-cache.e2e.test.ts`, "shows the chats before the session check answers") is
  timing-sensitive: it failed 2 of 10 runs on the Phase 15.2 build and 2 of 10 on this build, and passes when run
  again, so it is not caused by this phase.
* Real builds on GitHub Actions (branch `app-build-check`, deleted afterwards): the Android app builds and passes
  its checks (version 1.0.n, target SDK 36) and, installed on an Android 15 emulator, opens the live bedochat.com
  through Chrome (still with an address bar there: that test build is not signed with the upload key and the live
  site does not publish `assetlinks.json` until this phase is deployed); the iPhone app builds for the simulator, and
  launched in an iPhone 16 simulator it shows the live bedochat.com sign-in page in light and dark mode.

Not verifiable here: delivery to a real phone, which needs the Google Play / Apple keys of the owner's accounts
(APPS.md section C is the check), and Apple's review.

## Phase 16.1 — the Bedo Chat brand everywhere (D-54)

The owner's logo and icon (`docs/brand`, as delivered) replace the Phase 13 icon on the website, the Admin Dashboard
and both apps. `scripts/build-app-icons.mjs` makes every file from `apps/web/public/icons/bedo-icon.svg`:

| Where | What |
| --- | --- |
| Website | `favicon.ico` (16, 32, 48), `/icons/bedo-icon.svg` (SVG favicon), Home Screen icons 192 and 512, maskable 512 (drawing inside the safe circle), Apple touch icon 180 (full bleed), notification icon and one-colour badge (`badge-96.png`) |
| Pages | Sign-in of the student app and of the Admin Dashboard: the full logo (navy on light screens, white on dark, following the chosen theme like the colours; `BrandLogo` in `@bedo/ui`); Admin Dashboard header, empty chat pane and "not found" pages: the icon (`BrandIcon`) |
| Android | Launcher icon, round icon, adaptive icon (gradient background, drawing in the 66 dp safe circle), Android 13 themed (one-colour) icon, notification icon, splash image |
| iPhone | App Store icon 1024 (full bleed, no transparency), launch image |

Checks: the browser test now loads every brand file from the site as an image and checks that exactly one version
of the logo shows, loaded, on both sign-in pages in light and dark mode, with no Content-Security-Policy refusal.

