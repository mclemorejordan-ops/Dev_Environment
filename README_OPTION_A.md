# Gym Dashboard — Option A Restructure (No Build)

## What changed
- `index.html` now loads **one** script: `./assets/js/app.js`
- `./assets/js/app.js` is a **stub** that delegates to `./assets/js/app.entry.js`
- `./assets/js/app.entry.js` loads everything else in a **deterministic order**:
  1. `./assets/js/legacy/app.legacy.js` (your original `app.js`)
  2. `./assets/js/modals/*.js`

This removes script-tag ordering problems and gives every feature area its own folder.

## Folder layout
- `assets/js/legacy/` — preserved monolith while we stabilize
- `assets/js/modals/` — each modal isolated in its own file
- `assets/js/pages/` — reserved for future page/view split
- `assets/js/ui/` — reserved for UI components
- `assets/js/core/` — reserved for utilities/state/storage

## Safe development rule
- Do NOT add new `<script>` tags to `index.html`.
- Add new feature files to the `scripts` list inside `assets/js/app.entry.js`.

