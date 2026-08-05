# Pinboard Setup Guide

Pinboard works fully offline once installed — you can log games and see analytics with zero ongoing internet connection. This guide is mainly for turning on **account sign-in**, so your data follows you across devices. (Google Sheets sync has been retired in favor of this — see `pinboard-backend/ACCOUNTS_SETUP.md`.)

> **Important: this app must be opened over `http://` or `https://` — not by double-clicking `index.html`.**
> Browsers block `localStorage` (the technology this entire app is built on for saving your games) when a page is opened directly from disk via `file://`. If you open `index.html` that way, you'll see a red banner at the top explaining this, and buttons like "Save Game" won't actually persist anything even though the app otherwise looks normal. This isn't a bug to fix — it's a browser security restriction with no workaround. The fix is simply to serve the files (see below), which takes a few free minutes and then works permanently, including fully offline after that first load.

## Appearance: Light / Dark mode

Under **Settings → Appearance**, tap **Dark** or **Light** to switch themes instantly. Dark is the default. Your choice is saved immediately and applied the next time you open the app — no flash of the wrong theme, even offline.

## Part 1 — Install the app on your Android phone

1. Host the app files somewhere reachable over HTTPS (see "Where to host it" below). Do not open `index.html` directly from disk — see the note above.
2. Open the site in **Chrome on Android**.
3. Tap the **⋮** menu → **Add to Home screen** → **Install**.
4. Pinboard now launches full-screen from your home screen like a normal app.

**Want a real installable `.apk` file instead** (no browser involved at all, closer to a Play Store app)? See `ANDROID_APK_GUIDE.md`, which walks through packaging Pinboard with Google's TWA tool — it builds on the same hosted URL from this section, so do the hosting step here first either way.

### Where to host it
Any static host works since this is just HTML/CSS/JS — no server required:
- **GitHub Pages** (free): push these files to a repo, enable Pages in repo settings.
- **Google Cloud Storage / Firebase Hosting**: since you already work in GCP, `firebase deploy` after `firebase init hosting` is a 5-minute path.
- **Netlify / Vercel**: drag-and-drop the folder in their dashboard.

### Quickest way to just try it out locally first
If you want to test on your computer before deploying anywhere, you don't need any of the above — just serve the folder locally for a minute:
1. Open a terminal in the `pinboard` folder.
2. Run: `python3 -m http.server 8000` (Python is preinstalled on most systems; on Windows use `py -m http.server 8000`).
3. Open `http://localhost:8000` in Chrome. This counts as being served over `http://`, so everything will work correctly, including saving games.
4. Press Ctrl+C in the terminal when you're done.

This won't work from your phone unless your phone is on the same network and you use your computer's local IP instead of `localhost` — it's mainly useful for a quick desktop check before you deploy to a real host for phone use.

## Getting around

Tap the **☰** icon in the top-left to open the menu — it slides in from the left with Home, History, Stats, Leagues, Tournaments, Balls, Lane Finder, and Settings. Tap any item to jump there (the menu closes automatically), or tap outside the menu / the **✕** to close it without navigating.

Account sign-in (below) requires the app be served over **http(s)**, not opened as a bare `file://` path, because Google's OAuth flow requires a registered origin.

---

## Part 2 — Enable account sign-in (one-time, ~20–30 minutes)

**This requires a one-time setup step outside the app itself.** Pinboard ties your data to a real account instead of a per-device Google Sheet, so it needs a small free database (Supabase) and a Google sign-in connection to it.

**Follow the separate guide that came with your Pinboard download: `pinboard-backend/ACCOUNTS_SETUP.md`.** It walks through creating a free Supabase project, setting up the database tables, connecting Google sign-in, and filling in `config.js` — one time only. Once that's done, come back here:

1. Open Pinboard → **Settings → Your Account**.
2. Tap **Sign in with Google**.
3. From then on, every game, league, tournament, and ball you log saves to your account, and signing into the same account on another device pulls it all back down.

**Worth knowing before you rely on this:** this first version requires an internet connection for every save (no offline queueing yet), and doesn't yet migrate data you may already have sitting in this browser from before you had an account — see the "What's next" section at the bottom of `ACCOUNTS_SETUP.md` for what's planned.

---

## Part 3 — Enable photo score scanning (optional)

Pinboard can read a photo of a bowling alley's electronic scoring monitor and pre-fill the frame-by-frame entry form for you to review and save. This uses Anthropic's API directly from your browser with your own API key.

### Step 1: Get an API key
1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).
2. Sign in / create an account, create a new API key, and copy it (starts with `sk-ant-`).
3. Anthropic API usage is pay-as-you-go — add a small amount of credit to your account. Each photo scan costs a small fraction of a cent.

### Step 2: Add it to Pinboard
1. Open Pinboard → **Settings** → **Photo Score Scanning**.
2. Paste your key and tap **Save Key**.
3. The key is stored only in your phone's browser local storage. It's sent only to `api.anthropic.com` when you scan a photo — never to any other server, and never synced to your account.

### Step 3: Use it
1. Tap the **+** button to log a game → **Scan score from photo**.
2. Take a clear, well-lit photo of the monitor's frame grid (or pick an existing photo).
3. The form pre-fills with the extracted frame-by-frame values — **always double-check each frame** against the monitor before saving, especially the 10th frame's bonus balls, since digit misreads are the most common failure mode.

### Cost and privacy notes
- You're billed directly by Anthropic for scans, at standard API rates — there's no markup or subscription from this app.
- If you remove your key in Settings, the Scan button will prompt you to re-add one before working again.
- Multiple bowlers on one monitor: the model is prompted to use the most prominent/active row, but always verify — it can't reliably tell which lane is "yours" from the image alone.

---

## Part 4 — Ball lineup & alley tracking

Your **Bowling Ball Lineup** has its own page in the left menu (☰ → **Balls**): tap **+ Add Ball** to open a small form for Brand (e.g. "Storm") and Model (e.g. "Phaze II") — only Model is required. Balls are listed and shown everywhere in the app as **Brand - Model** (or just the model name if you left brand blank). Tap the ★ next to any ball to make it your default; the default pre-fills automatically every time you log a game, but you can change it per game.

**Ball specs**: tap a ball's name to open its detail view, then tap the **✎** icon to add or edit specs — brand, weight, RG, differential, hook potential, and notes as free text, plus **Coverstock type** (Solid, Pearl, Hybrid, Particle) and **Ball type** (Symmetric Core, Asymmetric Core) as dropdowns, so those two stay consistent across your whole lineup. Nothing saves until you tap **Save Specs**.

**Ball performance**: that same detail view also shows **Statistics** (games logged with this ball, scratch average, high, and low) and **History** (every session that used it, grouped and drillable exactly like the main History tab — tap through to see individual games and full frame-by-frame detail).

**Bowling Alleys** stay under **Settings**: add the alleys you bowl at there.

If you've signed in to an account (see Part 2), your ball lineup (including any specs you've entered) and alley list sync too — so adding a ball or its specs on your phone shows up on your tablet the next time you open Pinboard there. **Worth knowing:** unlike the old Sheets sync, this first version doesn't merge changes made on two devices before either has synced — each save replaces the full list for that data type with whatever's on the device doing the saving. In practice this is rarely an issue since you're usually only actively using one device at a time, but if you add a ball on your phone and, before opening Pinboard on your tablet to pick that up, also add a different ball on your tablet, whichever device saves second will overwrite the first device's addition rather than keeping both.

**Lane condition**: when logging a game, an optional **Lane condition** dropdown lets you record the oil pattern — Heavy Oil, Medium Oil, Light Oil, or Dry. It applies to every game in that session (matching how ball, alley, and league already work), shows up in each game's detail view and in the session summary when you drill into a multi-game session, and syncs to your account like everything else. Leave it blank if you don't track this.

---

## Part 5 — Location features (optional): automatic alley detection, Lane Finder, and maps

Pinboard can automatically fill in the alley when you log a game, show every nearby bowling alley on a dedicated **Lane Finder** page with hours/phone/website/an embedded map, and filter that list by distance — all based on your phone's actual location via Google's Places and Maps APIs.

**This requires a one-time setup step outside the app itself.** Rather than pasting a Google API key directly into Pinboard (which would mean anyone who opens the app's files could read it out), Pinboard routes these location features through a small free proxy you deploy yourself on Cloudflare Workers. Your Google key lives there, privately, never inside Pinboard's own code.

**Follow the separate guide that came with your Pinboard download: `CLOUDFLARE_SETUP.md`.** It walks through getting a Google API key, deploying a free Cloudflare Worker, and connecting the two — about 15–20 minutes, one time only. Once that's done, come back here:

1. Open Pinboard → **Settings → Location Features**.
2. Paste your deployed Worker's URL, tap **Save**.
3. Tap **📍 Test Detection Now** and **🗺️ Test Map Now** to confirm both are working.

If you skip this setup, everything else in Pinboard works exactly the same — alley selection just stays fully manual, and Lane Finder shows a message explaining what's needed rather than an error.

### How automatic detection works
- When you tap **+** to log a game, Pinboard checks your location and fills in the nearest real bowling alley automatically — adding it to your saved list first if it's new, or matching an existing similarly-named entry rather than creating a duplicate (e.g. "Thunderbird Lanes" vs "Thunderbird Bowling Lanes"). You can always change the auto-filled selection before saving.
- This searches within about 500 meters of your location. If you have a league selected with its own default alley, detection runs afterward and takes priority if it finds a result — since where you actually are matters more than where you usually go.
- A failed detection (denied permission, nothing nearby, etc.) stays silent during normal game logging — it shouldn't interrupt you mid-score-entry. If it's never working, **Settings → Location Features → 📍 Test Detection Now** always shows you the exact reason instead.

### Lane Finder
- The **Lane Finder** page (☰ menu) shows every real bowling alley near your current location — not limited to alleys you've already saved.
- Tap a distance chip — **5, 10, 25, or 50 miles** — to filter. Switching between them re-filters instantly from the same search rather than re-querying every time.
- **A real limit worth knowing**: Google's Places API can only search up to about 31 miles (50km) per request — a hard cap on Google's end. Picking 50 mi says so directly in the status line rather than pretending it searched further.
- Tap any result for more: hours (today highlighted), phone (tap to call), website (tap to open), and an embedded map.

### Cost and privacy
- Google bills usage directly to whichever Google Cloud project your key belongs to, at standard rates, with a monthly free credit that typically covers casual personal use — see [Google's Places API pricing](https://mapsplatform.google.com/pricing/).
- Your location is only requested when needed (opening the Add Game sheet, or the Lane Finder page), sent only through your own Cloudflare Worker to Google, and never stored or logged by Pinboard itself.

---

## Part 6 — Leagues

The **Leagues** page (☰ menu) lets you set up each league you bowl in as its own profile:

- **Name, team name, and team size**
- **Alley** — pick from your saved alleys list
- **Season start/end dates** and a **weekly day + time**
- **Notes** (e.g. "skips holiday weeks")

Once a league is set up, it appears as a dropdown option when logging a game — selecting it auto-fills that league's alley (still editable per game), and the app remembers your last-used league so repeat entry during a season is a single tap.

**Tapping a league** opens its detail view: full info (team, schedule, season, alley, notes), scratch statistics (games, average, high, low) across every game logged under it, and its game history grouped into sessions exactly like the main History tab — tap any session there to drill into it the same way. Tap the **✎** icon at the top of that view to edit the league's info, or delete it.

**Add to phone calendar**: once a league has a day, time, and season start/end filled in, an **"Add weekly matches to phone calendar"** button appears when editing it. Tapping it downloads a standard `.ics` calendar file with a weekly-recurring event for the whole season — opening that file hands it to whichever calendar app your phone uses by default (Google Calendar, etc.). This is entirely optional; nothing about logging games requires it.

Deleting a league doesn't touch games already logged under it; those games keep their recorded league name for history purposes, they just won't link to a live league profile anymore.

If you're upgrading from an older version of Pinboard that only had free-text league names, your existing per-league alley association is automatically converted into a real league profile the first time you open the updated app — nothing is lost, though you may want to fill in the newer fields (team info, schedule) on each migrated league afterward.

Leagues sync to your account the same way balls and alleys do, if you've signed in.

**Filtering Stats by a specific league**: on the **Stats** tab, tap **League** in the All/League/Open toggle — a dropdown appears letting you narrow everything (average, high/low, trend chart, distribution) down to one specific league instead of all league play combined. Pick "All Leagues" to go back to the combined view. This is handy if you bowl in more than one league and want to see how you're doing in each separately.

**Current vs. Completed leagues**: the Leagues tab has its own **Current / Completed / All** filter, defaulting to Current. A league automatically moves to Completed once its season end date has passed — no action needed. If you want to close one out early (or a league genuinely has no fixed end date and you're just done with it), open the league's detail view, tap **✎** to edit it, and tap **Mark as Completed Now**. Opening a completed league for editing reveals a **Final standing** field (e.g. "3rd of 12 teams") and a notes field for details like points behind or playoff results — these show up on the league's card and detail view afterward. If a league was auto-completed by date but the season actually isn't over, tap **Reopen This League** to clear its end date and set a new one.

**Comparing stats with your team**: if you're signed in to an account (see `pinboard-backend/ACCOUNTS_SETUP.md`), a league's detail view has a **Team** section where you can invite teammates directly by their Pinboard username. The first person you invite to a given league automatically sets up the shared team behind the scenes — nothing extra to create or configure. Once invited, everyone in that league's team can see each other's games *logged under that specific league* (not their whole account, not other leagues) alongside their own — a real, live comparison of who's shooting what, not just your own history. The league's own **team size** field (if you've filled it in) caps how many people can join; leave it blank and a reasonable default cap is used instead. Only you can invite people to leagues you created; anyone already on the team can invite others in, but only whoever's league it originally was can remove someone.

---

## Part 7 — Tournaments

The **Tournaments** page (☰ menu, right under Leagues) tracks tournaments as their own profiles, separate from your regular league and open play:

- **Name, format** (e.g. "4-game singles"), and **entry fee**
- **Alley** — pick from your saved alleys list
- **Dates**: choose **Single day** for a one-day event, or **Multi-day range** for a start/end span — pick whichever fits.
- **Notes** (e.g. "Squad time 10am")

**Logging tournament games works differently than league/open games.** Rather than using the main **+** button and a League/Open toggle, tap **📝 Log Tournament Game** on the Tournaments page. That opens its own form: pick which tournament, a date, ball, lane condition, and enter one or more games (with the same multi-game stepper and frame-by-frame option as regular game logging). This keeps tournament results cleanly separated from your regular league and open play stats, while still supporting everything else — multi-game sessions, frame scoring, ball tracking.

**Tapping a tournament** opens its detail view: full info (format, dates, alley, entry fee, notes), scratch statistics across every game logged under it, and its game history grouped into sessions exactly like League Detail and the main History tab. Tap the **✎** icon to edit the tournament's info or delete it.

**Current vs. Completed tournaments**: same pattern as Leagues — a tournament automatically moves to Completed once its date (or range end date) has passed. Editing a completed tournament reveals a **Final standing** field (e.g. "3rd of 40 bowlers") and placement notes. Tap **Mark as Completed Now** to close one out early, or **Reopen This Tournament** if it was auto-completed by date but isn't actually over.

Deleting a tournament doesn't touch games already logged under it — they remain in your History, they just won't link to a live tournament profile anymore.

Tournaments sync to your account the same way leagues, balls, and alleys do, if you've signed in. Tournament games show up in History alongside your league and open games (with their own tag color) and are fully usable in custom Analytics widgets — for example, "Average Score by Tournament" isn't a built-in widget, but "Games Played" or "Average Score" broken down by any variable you've logged will still include tournament games in the totals.

---

## Frame-by-frame entry: the pin keypad

When you switch to "Enter frame-by-frame instead," tapping any ball opens a custom on-screen keypad instead of your phone's regular keyboard — the regular numeric keyboard has no way to enter a strike or a spare, which this replaces entirely.

The keypad shows:
- **Numbers 0–9** for a plain pin count.
- A dedicated **Strike** button, enabled whenever a strike is actually legal for that specific ball (the first ball of any frame, or the appropriate reset balls in the 10th frame after an earlier strike or spare).
- A dedicated **Spare** button, enabled whenever the current ball would complete a frame's pins to exactly 10 — it fills in the exact remaining count automatically rather than making you do the subtraction.
- Numbers that would create an impossible pin count for that ball (e.g. entering another 6 after already bowling an 8 in the same frame) are grayed out, so it's not possible to accidentally enter a score that couldn't happen in a real game.

Entered balls display using standard scoresheet notation — **X** for a strike, **/** for a spare, or the plain number otherwise — right on the button, so the frame grid reads the way a paper scoresheet would.

## Logging multiple games at once

When you tap **+** to log a game, use the **Games played this session** stepper (1–10) to set how many games you bowled. With more than one game selected:

- A separate score card appears for each game (or a full frame-by-frame grid for each, if you've switched to frame entry — the mode applies to all games in the session at once).
- Date, league, ball, alley, and notes are shared across the whole session and saved once per game.
- Each game's "Scan score from photo" gets its own **Scan this game** link, so you can photograph each frame grid separately and have it land in the right card.
- Saving checks every game's score before saving any of them — if one entry is incomplete or invalid, nothing saves and you'll be told which game to fix.
- Reducing the count (e.g. from 3 back to 2) keeps whatever you'd already entered for the remaining games.

## Recent Games and History: grouped by session

Home's "Recent Games" and the History tab both group games logged together (same date, same league or Open/Practice, same alley) into a single row, since that's how bowling actually happens — a set of games in one outing, not isolated scores.

- **Single-game session**: shows just the score, same as before.
- **Multi-game session**: shows the number of games, average score, high and low, plus the league's day/time (if the league has a schedule set) and the alley — all in one row.
- **Tap a session row** to see it in detail: multi-game sessions open a summary sheet with games count, scratch total, scratch average, and scratch high, followed by each individual game (in the order you entered them, with the session's high game highlighted). Tapping any individual game there opens its full detail, including frame-by-frame breakdown if you entered it that way. Single-game sessions skip straight to that same full detail, since there's nothing to expand.

## Customizing the Analytics (Stats) page

The Stats page ships with the same four widgets it's always had — Games/High/Low, Score Trend, Last 5 vs Season, and Score Distribution — in that order. Tap **Edit** at the top of the page to customize it:

- **Show/hide widgets** with the toggle switch next to each one.
- **Reorder** by dragging the ⠿ handle up or down.
- **Strike/Spare Rate** is a fifth built-in widget, off by default (only meaningful for games you logged frame-by-frame — it'll tell you if you don't have any of those yet).
- Changes only take effect when you tap **Done**; tapping outside the editor or navigating away discards anything you changed.
- **Reset to Default** restores the original four widgets in the original order — handy if you want to start over.

### Filtering by date range

Below the All/League/Open toggle, a second row lets you narrow every widget on the page to a specific time period: **All Time** (default), **30 Days**, **90 Days**, or **Custom** (pick your own start and end dates). This stacks with the League/Open filter and the per-league dropdown — for example, you can view just one league's stats for the last 30 days. Custom widgets you've built respect this filter too, same as the built-in ones.

### Building your own widgets

Tap **+ Add Custom Widget** in the editor to create a breakdown of your own choosing:

1. **Track by** — pick the variable to group your games by: Ball, Alley, League, Lane Condition, or League vs Open.
2. **Show** — pick what to measure for each group: Average Score, High Score, Low Score, Total Pins, or Games Played.
3. **Chart type** — pick how it's visualized: **Bar** (a sorted horizontal bar list, highest first), **Line** (a connected line across each group), or **Number only** (just the figures, no bar).

For example, "Average Score by Lane Condition" as a Bar chart shows which oil pattern you tend to score best on; "Games Played by League" as a Number list just shows the raw counts side by side. Any combination of variable, metric, and chart type is fair game — there's no limit to how many custom widgets you can create.

Tap a custom widget's name (with the ✎) in the editor to change its variable, metric, or chart type later, or to delete it.

If you're signed in to an account, this layout syncs along with everything else, so it'll look the same across your devices rather than needing to be set up separately on each one (this is a change from the old per-device-only behavior). Theme (Light/Dark) works the same way now too. If you're not signed in, both stay local to this device only.

## Troubleshooting: "the app loads but buttons don't respond"

This app is installed as a PWA with an offline-capable service worker, which means your phone caches the app's files locally. If you update/redeploy the app's files, your phone should pick up the new versions automatically on next launch — but if something ever slips through stale (e.g. you had the app open across an update), the fix is a hard refresh:

1. Close the app completely (swipe it away from recent apps, don't just background it).
2. Re-open it. The service worker is written to always check the network first for the app's own files, so this alone should self-heal it.
3. If it still misbehaves: in Chrome, go to Settings → Site settings → find the site → **Clear & reset**, then reload and re-add to home screen. This wipes the local cache and forces a completely fresh copy of every file.

As of this version, the service worker fetches app files network-first (falling back to cache only when offline), specifically to prevent this class of issue going forward.
