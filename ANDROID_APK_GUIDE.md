# Packaging Pinboard as an Android APK

This turns Pinboard into a real, installable `.apk` file — something you can install directly on
a phone, or eventually publish to the Play Store — instead of using "Add to Home Screen." The
result opens full-screen with no browser address bar, just like any other Android app.

**This uses TWA (Trusted Web Activity)**, Google's own official tool for exactly this purpose.
It's free, and it works by pointing at a real, hosted copy of Pinboard — a TWA cannot wrap local
files sitting on your computer, only a live website. That's a hard requirement of how TWA (and
Android in general) verifies which app "owns" a given web address, not a limitation specific to
Pinboard.

**Time required:** about 30–45 minutes the first time, mostly one-time setup.
**Cost:** free. (Publishing to the Play Store later, if you ever want to, has a one-time $25
Google Play developer account fee — but installing the APK directly on your own phone, which is
what this guide covers, costs nothing.)

**Before you start:** if you've already set up the Cloudflare Worker proxy for location features
(`CLOUDFLARE_SETUP.md` in the `pinboard-proxy` folder), do that first or do it alongside this —
they're independent of each other, but both are one-time setup steps you'll want done before
using the app day-to-day.

---

## Part A — Host Pinboard at a real HTTPS address

Pinboard currently exists only as local files on your computer. TWA needs it reachable at a real
public URL — this is also a requirement for the app to actually work at all (see the note in
`SETUP.md` about `localStorage` and `file://`), so this step matters regardless of the APK.

**GitHub Pages** is the recommended option here: free, no credit card, and pairs cleanly with the
rest of this guide.

1. Create a free account at [github.com](https://github.com/) if you don't have one.
2. Create a new repository (**+** in the top right → **New repository**). Name it anything, e.g.
   `pinboard`. Keep it **Public** (GitHub Pages' free tier requires this).
3. Upload all of Pinboard's files into it — the easiest way is dragging the whole `pinboard`
   folder's contents into GitHub's web upload page (**Add file → Upload files**), or using `git`
   directly if you're comfortable with it.
4. In the repository, go to **Settings → Pages**.
5. Under **Source**, select **Deploy from a branch**, branch **main**, folder **/ (root)** → **Save**.
6. Wait a minute or two, then refresh — GitHub will show your live URL, something like:
   `https://yourusername.github.io/pinboard/`
7. Open that URL in Chrome and confirm Pinboard loads and works (try logging a test game) before
   moving on.

**Write down this exact URL — you'll need it precisely in the steps below.**

If you already have the Cloudflare Worker proxy set up, this is also a good moment to revisit the
optional hardening step in `CLOUDFLARE_SETUP.md` (`ALLOWED_ORIGIN`) now that Pinboard has a fixed
address — it's still optional, but this is when it becomes genuinely useful to do.

---

## Part B — Install Bubblewrap

Bubblewrap is Google's own command-line tool for building a TWA. It manages its own copy of the
Android build tools, so you don't need to separately install Android Studio.

1. Confirm you have Node.js installed — open a terminal and run `node --version`. If that shows
   an error instead of a version number, install Node.js from [nodejs.org](https://nodejs.org/)
   first (the "LTS" version), then continue.
2. Install Bubblewrap globally:
   ```
   npm install -g @bubblewrap/cli
   ```
3. Verify it installed:
   ```
   bubblewrap --version
   ```
   You should see a version number, not an error.

---

## Part C — Generate the Android project

1. In a terminal, navigate to wherever you want the Android project files to live (this creates a
   new folder — it's separate from your `pinboard` app files and doesn't need to be inside them):
   ```
   cd ~/Desktop
   mkdir pinboard-android
   cd pinboard-android
   ```
2. Run:
   ```
   bubblewrap init --manifest=https://yourusername.github.io/pinboard/manifest.webmanifest
   ```
   (Replace the URL with your actual GitHub Pages URL from Part A.)
3. Bubblewrap will ask a series of questions. The defaults it reads from Pinboard's own
   `manifest.webmanifest` are already correct for most of these — press Enter to accept the
   default unless noted otherwise below:
   - **Domain**: should auto-fill as `yourusername.github.io` — confirm this matches exactly.
   - **URL path**: should auto-fill as `/pinboard/` (or wherever you put it) — confirm it matches.
   - **Application name**: defaults to "Pinboard — Bowling Tracker" — shorten this if you'd
     rather the installed app's name be simpler, e.g. just "Pinboard".
   - **Package name**: this is Android's internal identifier (like `com.example.pinboard`) — the
     suggested default is fine unless you're planning to eventually publish to the Play Store
     under your own developer account, in which case use something unique to you.
   - The rest (icon, colors, orientation) will read correctly from the manifest already — accept
     the defaults.
4. The **first time** you run this, Bubblewrap will offer to download and set up the Android SDK
   and a JDK for you if it doesn't detect them — say yes. This step can take several minutes and
   several hundred MB of downloads; it only happens once.
5. When it finishes, you'll have a new `twa-manifest.json` file and a full Android project folder
   in `pinboard-android`.

---

## Part D — Build the APK

1. Still inside the `pinboard-android` folder, run:
   ```
   bubblewrap build
   ```
2. The **first time**, this will generate a new **signing key** for you — a file usually named
   `android.keystore`. **Back this up somewhere safe.** If you ever want to update this app later
   (rebuild it with a new version, add features, etc.), you'll need this exact same signing key,
   or Android will refuse to let the update replace the original install. Losing it doesn't break
   the app you already installed, but it does mean any future rebuild would have to be installed
   as a brand-new separate app rather than an update.
3. When the build finishes, you'll have a file named something like `app-release-signed.apk` in
   that folder.

---

## Part E — Verify the connection between your site and the app (Digital Asset Links)

This is the step that makes the installed app open full-screen with no browser address bar,
instead of just behaving like a bookmark that opens Chrome. Android checks a specific file on your
website to confirm you (the same person who built the APK) actually control that URL.

1. Bubblewrap generates a file called `assetlinks.json` during Part C — find it in your
   `pinboard-android` project folder (usually under `app/src/main/assets/.well-known/`).
2. Copy that exact file into your Pinboard files, at this specific path:
   `.well-known/assetlinks.json` (create the `.well-known` folder if it doesn't exist).
3. Upload/commit that folder to your GitHub Pages repository from Part A, so it's reachable at:
   `https://yourusername.github.io/pinboard/.well-known/assetlinks.json`
4. Open that exact URL in a browser to confirm it loads and shows JSON content (not a 404).

If this file isn't reachable at that exact path, the app will still work, but it'll show a
browser-style address bar at the top instead of looking like a native app.

---

## Part F — Install it on your phone

1. Copy `app-release-signed.apk` (from Part D) onto your Android phone — email it to yourself,
   use a USB cable, upload it to Google Drive and download it on the phone, or similar.
2. On your phone, open the APK file. Android will likely warn about installing from an unknown
   source the first time — this is normal for any app not installed via the Play Store. You'll
   need to allow it (usually a one-time toggle in the install prompt, or under
   **Settings → Apps → Special access → Install unknown apps** for whichever app you used to open
   the file, like Files or Gmail).
3. Once installed, open it from your app drawer like any other app. It should launch full-screen,
   with no address bar, and everything — saved games, settings, Sheets sync, Lane Finder — should
   work exactly as it did in the browser, since it's the same app underneath.

---

## Troubleshooting

**The app opens but shows a browser address bar at the top**
Digital Asset Links (Part E) isn't verified correctly. Double-check `assetlinks.json` is reachable
at the *exact* path `https://yourusername.github.io/pinboard/.well-known/assetlinks.json`, and
that its contents match what Bubblewrap generated (don't hand-edit this file).

**Nothing saves — games, settings, everything resets**
This means the app somehow ended up loading from `file://` instead of your real GitHub Pages URL.
Double-check the URL you gave Bubblewrap in Part C exactly matches where you hosted the app in
Part A, including the trailing `/pinboard/` path if that's part of your real URL.

**"App not installed" or "There was a problem parsing the package" on your phone**
Usually means the APK file got corrupted in transfer (common with some email/messaging apps that
re-compress attachments) — try transferring it a different way, e.g. a direct USB copy or Google
Drive.

**Bubblewrap can't find Java / JDK errors during `bubblewrap init` or `bubblewrap build`**
Bubblewrap manages its own JDK, but a separately-installed Java version on your system can
sometimes conflict. If you hit Java-related errors, check
[Bubblewrap's own documentation](https://github.com/GoogleChromeLabs/bubblewrap) for current
guidance, since exact JDK version requirements can shift between Bubblewrap releases.

**I lost my signing keystore and need to update the app**
There's no way to recover it — you'd need to build a fresh APK with a new signing key, which
means anyone who has the old version would need to uninstall it and install the new one fresh
(their saved data stays on the phone either way, since Pinboard's data lives in the browser
engine's storage, not tied to the specific APK signing key — but this is a good reason to back up
the keystore file properly the first time).

---

## What this does and doesn't do

- This makes Pinboard installable and app-like on your own phone. It does **not** publish it
  anywhere or make it available to anyone else, unless you separately choose to publish it to the
  Play Store (a different process, requiring a one-time $25 Google Play developer account).
- Every update to Pinboard's actual code (new features, bug fixes) just means updating the files
  at your GitHub Pages URL — you do **not** need to rebuild the APK for that, since the APK is
  just a thin wrapper pointing at that live URL. You'd only rebuild the APK itself for things like
  changing the app's name, icon, or package identifier.
- The Cloudflare Worker proxy setup (if you've done it) works identically here — nothing about
  packaging as an APK changes how Pinboard talks to your Worker, since it's the same web code
  running either way.
