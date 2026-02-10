# Gym Dashboard (Offline Tracker)

A minimalist, iOS-style gym tracking dashboard that runs entirely in the browser (no login, no backend).
Tracks weight, protein, attendance, routines, and lift progress with PR history.

## Features

- **Onboarding**
  - Create profile (name, protein goal, week starts on, hide rest days)
  - Create routine from templates (PPL, Upper/Lower, Full Body 3-day, Body Part Split, or blank)

- **Home Dashboard**
  - Today’s workout (auto based on day of week)
  - Weekly attendance dots + quick “Check In”
  - Protein “grams left” ring + focus text

- **Routine**
  - Multiple routines (create / edit / duplicate / delete)
  - Template routines can be converted into saved routines
  - Mark days as rest days (hidden if enabled)

- **Log Sets**
  - Log sets per exercise (weight + reps)
  - Automatically calculates **lifetime max** + **PR flags**
  - Exercise history modal

- **Progress**
  - Table view + graph view (Chart.js)
  - Graph metrics:
    - Top Weight
    - Estimated 1RM (Epley)
    - Volume
  - Download current graph as PNG

- **Weight**
  - Table view + graph view (Chart.js)
  - Latest, delta, and 7-day average

- **Attendance**
  - Tap calendar days trained
  - Monthly count + clear month

- **Protein**
  - Daily meal breakdown + remaining goal
  - Home ring updates live while typing (today)

- **Backup / Import**
  - Export full app data as JSON
  - Import export JSON (overwrites current browser data)

## Data Storage (Important)

This app stores data using **localStorage** on the device/browser you use.
That means:
- Clearing browser data clears your gym data.
- Using a different browser/device starts fresh unless you import a backup.

**Recommended:** Use “Backup Now” in Settings regularly.

## Run Locally

### Option 1: Open directly
Open `index.html` in your browser.

> Note: Some browsers block certain features when running from `file://`.
> If anything behaves oddly, use a local server.

### Option 2: Run a simple local server (recommended)

#### macOS / Linux
```bash
