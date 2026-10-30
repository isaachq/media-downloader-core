# Privacy Policy & Data Safety

**Last Updated:** October 30, 2026  
**Project:** Media Downloader Core & Media Downloader Core for Android  
**Maintainer:** isaachq (`isaac.hernandez.qz@gmail.com`)  
**Repository:** [https://github.com/isaachq/media-downloader-core](https://github.com/isaachq/media-downloader-core)  
**Language:** English | *Leer en [Español](PRIVACY_ES.md)*  

---

## 1. Overview & Commitment to User Privacy

Media Downloader Core (including its desktop CLI, desktop GUI, and Android mobile application) is built with a **strict privacy-first architecture**. 

* **Zero Personal Data Collection:** We do not collect, harvest, store, transmit, or monetize any personal identification information (PII).
* **No Ads, No Tracking for Advertising:** No advertising frameworks, no advertising ID, no fingerprinting. The library, CLI and desktop app send no telemetry at all.
* **Optional Anonymous Usage Statistics (Android app):** the Android app can send anonymous usage statistics (Firebase Analytics) to learn which features are used and what fails. You can turn it off at any time in Settings > Privacy. See section 3.
* **Zero Data Sharing or Selling:** We do not sell, rent, trade, or share user data with any third parties or advertisers.

---

## 2. Data Safety Specification (Google Play & App Store Compliance)

| Category | Specification | Details |
|---|---|---|
| **Data Collection** | **Anonymous and optional (Android app)** | App interactions, diagnostics (error codes) and a random app instance ID, only while "Share anonymous usage statistics" is on (section 3). No personal info, contact info, financial info, health info, or location data is collected. |
| **Data Sharing** | **None** | Usage statistics are processed by Google (Firebase) as a service provider for the maintainer only. No data is sold or sent to ad networks. |
| **Account Data** | **Local Only** | When optional account sign-in is used (e.g. for Instagram, TikTok, Facebook), session cookies are stored **exclusively in the application's private, encrypted sandbox on the local device**. |
| **Network Requests** | **Direct & User-Initiated** | Downloads and metadata queries connect directly between your device and the public source server. No intermediary proxy or tracking relay is utilized. |
| **Security Practices** | **OS Sandbox Encrypted** | Data is protected using standard operating system sandboxing and file-level permissions. |
| **Data Deletion** | **Full User Control** | Users can clear cookies, history, batch records, or stored media at any time from within the app. Uninstalling the application deletes all private application data immediately. |

---

## 3. Anonymous Usage Statistics (Android app only)

Since version 0.2.0-beta.45 the **Android app** can send anonymous usage statistics through Google Firebase Analytics. The library, the CLI and the desktop app send nothing.

**Why:** the app is made by one person, and their own phone is not the real world. Knowing which features are used and which sites and formats fail, and with which error, is how the app improves. There is no monetization behind it.

**Your choice:** it is on by default and you can turn it off at any time in **Settings > Privacy > Share anonymous usage statistics**. Off stops it immediately and stays off after a restart.

**What is sent** (only while the setting is on):
* Events: a download started, finished, failed, was cancelled or skipped; a batch or mix list was scheduled, and when a batch ends its report in numbers (how many downloaded, failed, were cancelled or unavailable, the commonest cause, how long it took); a link was read; a live recording started or ended; a sign-in or sign-out on a site; a screen was opened; a feature such as share or retry was used.
* With each event, only short codes and numbers: the site (for example `tiktok`), the format (for example `mp4_1080`), the engine's error code and step (for example `needs-sign-in`, `download`), attempts, file size in MB and duration.
* Device type (phone or tablet) and settings in use: app language, theme, default format, background, Wi-Fi only, gallery, retry mode, integrity check.
* What Firebase adds by itself: a random app instance ID (reset when you clear the app's data or reinstall), app version, Android version, device model, country, and how long the app and each screen are in use.

**What is never sent:** links (URLs), titles, user, channel or account names, file names or folders, error messages, cookies or sessions, the advertising ID or the Android ID. The app checks every value before sending and drops anything that is not a short code or a number, so a link or a title cannot be sent by mistake.

**Processor and retention:** Google LLC (Firebase Analytics) processes the data for the maintainer under the [Firebase data processing terms](https://firebase.google.com/terms/data-processing-terms). It is not sold, not shared with other companies and not used for advertising; ad personalization is disabled. Data is kept for the retention period configured in Firebase and then deleted. The data is not linked to your identity: to stop it, turn the setting off; to detach your past data from your device, clear the app's data or reinstall (a new random ID is created).

---

## 4. Storage & Permissions

* **Local App Storage:** Media files are saved either to the application's scoped storage directory or to a user-selected folder via the Android Storage Access Framework (SAF).
* **Foreground Service (`dataSync`):** Used strictly during active, user-initiated downloads to maintain the background download process and provide real-time progress notifications in compliance with Android 14+ requirements.
* **Notification Permission (`POST_NOTIFICATIONS`):** Used only to display the active download progress bar and completion status. Notifications are never used for marketing, promotions, or background polling.

---

## 5. Intellectual Property & Terms of Service Disclaimers

### A. Non-Affiliation Disclaimer
Media Downloader Core is an independent open-source software project. It is **not** sponsored, endorsed, affiliated, associated, or authorized by:
* **TikTok** or ByteDance Ltd.
* **Instagram**, **Facebook**, or Meta Platforms, Inc.
* Any other third-party platform or service provider.

All product names, logos, brands, trademarks, and registered trademarks belong to their respective owners. Their use in this documentation or application is solely for identification and interoperability purposes under nominative fair use.

### B. Copyright & Fair Use
* Media Downloader Core is designed as a tool for personal archiving, offline viewing, and educational backup of media that the user owns or has the explicit legal authorization and permission from the copyright owner to download.
* The application must not be used to violate copyright laws, circumvent digital rights management (DRM), or infringe upon the intellectual property rights of content creators.
* Users are solely responsible for compliance with applicable local copyright laws and the Terms of Service of any platform from which they access public content.

---

## 6. Changes to This Policy

If this policy is updated, modifications will be committed directly to this repository with an updated timestamp.

## 7. Contact

If you have questions, feedback, or concerns regarding this Privacy Policy:
* **GitHub Issues:** [https://github.com/isaachq/media-downloader-core/issues](https://github.com/isaachq/media-downloader-core/issues)
* **Email:** isaac.hernandez.qz@gmail.com
