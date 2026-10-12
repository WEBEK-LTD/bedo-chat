# Bedo Chat apps for Android and iPhone (D-53, Phase 16)

Both apps open **https://bedochat.com** inside them. Everything students see is the website, so every update to the
website is in the apps at once. There is no second copy of the student app, no database change and no SQL to run.

| | Android (`apps/android`) | iPhone (`apps/ios`) |
| --- | --- | --- |
| How it shows the site | Trusted Web Activity: the site full screen in the phone's Chrome engine | A web view inside the app |
| Notifications | The website's own notifications (Web Push), shown as the app's | Through Apple (APNs): the app gives the site its Apple address, saved like a browser's |
| What it needs | Google Play developer account | Apple Developer Program (paid yearly) |
| Built by | GitHub Actions, workflow **Apps** | GitHub Actions, workflow **Apps** (no Mac needed) |

Signing keys and Apple keys are never in the project: they live in the repository's **GitHub secrets** (for the
builds) and in **Netlify's environment variables** (the iPhone notification key). Without them the workflow still
builds both apps as a check, unsigned.

The app ID is **`com.bedochat.app`** on both stores. It can never change after the first upload.

---

## A. Android

### A1. Add the signing key to GitHub (once)

You receive two files with Phase 16: `keystore-base64.txt` and `password.txt` (the Android upload key). Keep a copy
of both somewhere safe, outside the project.

GitHub → **WEBEK-LTD/bedo-chat** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Name | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | everything in `keystore-base64.txt` |
| `ANDROID_KEYSTORE_PASSWORD` | the text in `password.txt` |

### A2. Get the app files

After uploading the project with GitHub Desktop: GitHub → **Actions** → **Apps** → the newest run → wait for a green
tick → at the bottom, **Artifacts** → **android-app**. The download holds:

* `bedo-chat-<number>.aab`: for Google Play.
* `bedo-chat-<number>.apk`: installs straight on an Android phone (for your own testing).

No change to the apps? GitHub → **Actions** → **Apps** → **Run workflow** → **Run workflow** builds them again.

### A3. Google Play Console (first time)

1. Play Console → **Create app** → name **Bedo Chat**, App, Free → Create.
2. **Testing** → **Internal testing** → **Create new release** → upload the `.aab` → Save → Review → Roll out.
   Google keeps the app signing key ("Play App Signing"): accept it.
3. **Test and release** → **Setup** → **App integrity** → **App signing** → copy the **SHA-256 certificate
   fingerprint** of the *App signing key certificate* and send it to Claude. It is added to the website's
   `/.well-known/assetlinks.json`; until then the app shows a small address bar at the top when installed from Google
   Play (the `.apk` from A2 already matches).
4. Fill in the store listing, content rating, privacy policy (**https://bedochat.com/privacy**) and data safety, then
   promote the release to **Production**.

Every build gets a higher version number by itself (Google Play refuses a lower one), so any build can be uploaded.

---

## B. iPhone

### B1. Apple Developer account (developer.apple.com, once)

1. **Certificates, Identifiers & Profiles** → **Identifiers** → **+** → **App IDs** → **App** → Description
   `Bedo Chat`, Bundle ID **Explicit** `com.bedochat.app` → tick **Push Notifications** → Continue → Register.
2. **Keys** → **+** → name `Bedo Chat notifications` → tick **Apple Push Notifications service (APNs)** → Continue →
   Register → **Download** (the `.p8` file can be downloaded only once). Note the **Key ID**.
3. **Membership details**: note the **Team ID** (10 letters and digits).

### B2. Netlify: the notification key (once)

Netlify → the **bedochat** site → **Site configuration** → **Environment variables** → **Add a variable** (each one):

| Key | Value |
| --- | --- |
| `APNS_KEY` | open the `.p8` file from B1.2 in TextEdit or Notepad and paste all of it |
| `APNS_KEY_ID` | the Key ID from B1.2 |
| `APNS_TEAM_ID` | the Team ID from B1.3 |

Then **Deploys** → **Trigger deploy** → **Deploy site**. Without these three the iPhone app works but gets no
notifications; the website is not affected either way.

### B3. App Store Connect (appstoreconnect.apple.com, once)

1. **Apps** → **+** → **New App** → iOS, name **Bedo Chat**, language English, Bundle ID `com.bedochat.app`,
   SKU `bedochat` → Create.
2. **Users and Access** → **Integrations** → **App Store Connect API** → **Team Keys** → **+** → name
   `GitHub builds`, access **Admin** (it makes the signing certificate and profile) → Generate → **Download** the `.p8` (once only). Note the **Key ID** and,
   above the list, the **Issuer ID**.

### B4. GitHub secrets (once)

GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Name | Value |
| --- | --- |
| `APP_STORE_CONNECT_KEY` | all of the `.p8` file from B3.2 |
| `APP_STORE_CONNECT_KEY_ID` | its Key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | the Issuer ID |
| `APPLE_TEAM_ID` | the Team ID from B1.3 |

### B5. Build and test

GitHub → **Actions** → **Apps** → **Run workflow**. The iPhone job builds the app and uploads it to App Store Connect.
About 15 minutes later it appears under **TestFlight**: add yourself as a tester and install it with the TestFlight
app. When it works, **App Store** tab → add the build, screenshots and description → **Submit for Review**.

Addresses the stores ask for (D-57): Privacy Policy URL **https://bedochat.com/privacy**, Support URL
**https://bedochat.com/support**, Marketing URL (optional) **https://bedochat.com**.

Apple's review sometimes refuses apps that only show a website (guideline 4.2). Bedo Chat's iPhone app has its own
notifications, sign-in that stays, and app icon badge, which is what reviewers look for; if they still ask for
more, Claude will help with the answer.

---

## C. Checking notifications

1. Install the app and sign in. The phone asks once to allow notifications: **Allow** (on older Android phones they are
   simply on). If it does not ask, the chat list shows **Turn on notifications…**: tap **Turn on**.
2. From another phone or a computer, send that account a message: the notification arrives with the sender and the
   text, also when the app is closed. Tapping it opens the chat.
3. Settings → **Notifications** in the app shows "Notifications are on for this device", and turns them off and on
   like on the website.
4. iPhone, "Don't Allow" pressed by mistake: Settings in the app shows **Open Settings**, which goes to the
   iPhone's Settings → Bedo Chat → Notifications.

---

## D. Store review account (Google Play and Apple sign-in details)

Reviewers cannot receive a WhatsApp code, so the stores need sign-in details that keep working.

1. Admin Dashboard → **OTP / WhatsApp** → **Store review account**: a phone number nobody else uses (it gets no
   WhatsApp code while this is on), a 6-digit code → **Save and turn on**.
2. Google Play Console → App content → App access → **All or some functionality is restricted** → Add instructions:
   * Name: `Store review account`
   * Username / phone: the number, with `+` and the country code
   * Password: leave empty
   * Any other information: `Bedo Chat signs in with a phone number and a 6-digit verification code. Enter the phone
     number above, tap Continue, then enter the code <your code>. The code does not expire and works every time for
     this review account. If asked for a name, enter any name.`
3. Apple (App Store Connect → the version → App Review Information → Sign-in required): the same number as user name,
   the code as password, and the same note.
4. Keep it on while the app is in review (Google reviews every update too). Turn it off any time; its sessions end.

## E. How the iPhone build is signed

Each run of **Apps** with the App Store Connect key makes, through that key, an Apple Distribution certificate (its
private key is made on the build machine and never stored) and an App Store profile named `Bedo Chat CI <number>`,
signs the app with them using Xcode 26 or later (Apple's requirement for uploads), checks that the signed app has the
push entitlement, and uploads it to App Store Connect. The next run removes the previous run's certificate and profile
(only those named `Bedo Chat CI ...`), so the account never collects them. No device has to be registered and no Mac is
needed (`apps/ios/ci/signing.py`).

