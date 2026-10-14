# Privacy Policy & Data Safety

**Last Updated:** October 14, 2026  
**Project:** Media Downloader Core & Media Downloader Core for Android  
**Maintainer:** isaachq (`isaac.hernandez.qz@gmail.com`)  
**Repository:** [https://github.com/isaachq/media-downloader-core](https://github.com/isaachq/media-downloader-core)  

---

## 1. Overview & Commitment to User Privacy

Media Downloader Core (including its desktop CLI, desktop GUI, and Android mobile application) is built with a **strict privacy-first architecture**. 

* **Zero Personal Data Collection:** We do not collect, harvest, store, transmit, or monetize any personal identification information (PII).
* **Zero Tracking / Zero Telemetry:** The application contains no analytics SDKs, advertising frameworks, crash telemetry trackers, or fingerprinting routines.
* **Zero Data Sharing or Selling:** We do not sell, rent, trade, or share user data with any third parties or advertisers.

---

## 2. Data Safety Specification (Google Play & App Store Compliance)

| Category | Specification | Details |
|---|---|---|
| **Data Collection** | **None** | No personal info, contact info, financial info, health info, or location data is collected. |
| **Data Sharing** | **None** | No data is transferred to external servers, third-party databases, or ad networks. |
| **Account Data** | **Local Only** | When optional account sign-in is used (e.g. for Instagram, TikTok, Facebook), session cookies are stored **exclusively in the application's private, encrypted sandbox on the local device**. |
| **Network Requests** | **Direct & User-Initiated** | Downloads and metadata queries connect directly between your device and the public source server. No intermediary proxy or tracking relay is utilized. |
| **Security Practices** | **OS Sandbox Encrypted** | Data is protected using standard operating system sandboxing and file-level permissions. |
| **Data Deletion** | **Full User Control** | Users can clear cookies, history, batch records, or stored media at any time from within the app. Uninstalling the application deletes all private application data immediately. |

---

## 3. Storage & Permissions

* **Local App Storage:** Media files are saved either to the application's scoped storage directory or to a user-selected folder via the Android Storage Access Framework (SAF).
* **Foreground Service (`dataSync`):** Used strictly during active, user-initiated downloads to maintain the background download process and provide real-time progress notifications in compliance with Android 14+ requirements.
* **Notification Permission (`POST_NOTIFICATIONS`):** Used only to display the active download progress bar and completion status. Notifications are never used for marketing, promotions, or background polling.

---

## 4. Intellectual Property & Terms of Service Disclaimers

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

## 5. Changes to This Policy

If this policy is updated, modifications will be committed directly to this repository with an updated timestamp.

## 6. Contact

If you have questions, feedback, or concerns regarding this Privacy Policy:
* **GitHub Issues:** [https://github.com/isaachq/media-downloader-core/issues](https://github.com/isaachq/media-downloader-core/issues)
* **Email:** isaac.hernandez.qz@gmail.com
