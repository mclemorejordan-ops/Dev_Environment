# Gym Dashboard (PWA)

A production-hardened, fully client-side Progressive Web App for
tracking:

-   Workouts & Routines
-   Exercise Progress
-   Weight Tracking
-   Protein Intake
-   Attendance
-   Backup & Restore

Built as a single-file SPA with deterministic service worker updates,
schema migration safety, and zero data loss guarantees.

------------------------------------------------------------------------

# Architecture Overview

## Core Files

  File                   Purpose
  ---------------------- ------------------------------------------------------------
  index.html             Main application (UI, routing, state engine)
  sw.js                  Versioned service worker (offline + deterministic updates)
  version.json           Single source of truth for version + release notes
  manifest.webmanifest   PWA install configuration

------------------------------------------------------------------------

# State & Schema System

The application uses a schema‑guarded local storage model.

``` js
const SCHEMA_VERSION = 1;
```

## Migration Strategy

All loaded state passes through:

``` js
migrateState(saved)
```

Guarantees:

-   Always merges into DefaultState()
-   Ensures required containers exist
-   Normalizes arrays/objects
-   Prevents runtime crashes from corrupted data
-   Automatically stamps latest schemaVersion

Critical containers guarded:

-   routines\[\]
-   exerciseLibrary.{weightlifting, cardio, core}\[\]
-   logs.{workouts, weight, protein}\[\]
-   attendance\[\]

No state is ever used without migration repair.

------------------------------------------------------------------------

# Versioning System (Deterministic Updates)

`version.json` is the single source of truth.

When version.json changes:

1.  The app detects a new version.
2.  Service worker URL becomes:

```{=html}
<!-- -->
```
    ./sw.js?v=<version>

3.  Browser installs new service worker.
4.  Old caches are deterministically removed.
5.  User taps "Reload to update".
6.  Controller switches once.
7.  App reloads safely without clearing localStorage.

User data is never wiped during updates.

------------------------------------------------------------------------

# Version Metadata Isolation

Version data is stored separately from user state:

-   gymdash:latestVersion
-   gymdash:appliedVersion
-   gymdash:latestNotes
-   gymdash:latestBuildDate

This ensures:

-   Updates do not modify profile data
-   Version tracking is device-specific
-   Safe reload under new build

------------------------------------------------------------------------

# Update Activation Safety

Before applying an update:

``` js
Storage.flush(state)
```

This guarantees:

-   No pending debounced writes are lost
-   No partial state corruption
-   Clean transition to new build

If a service worker is waiting:

    SKIP_WAITING

Otherwise, normal reload.

------------------------------------------------------------------------

# Backup & Import System

Export:

-   Full state snapshot
-   Wrapped payload with metadata

Import validation ensures:

-   Valid JSON
-   schemaVersion present
-   Required containers exist
-   Automatic migration before applying

Imported data fully replaces local state only after validation succeeds.

------------------------------------------------------------------------

# UI Architecture

-   Mobile-first (100dvh layout)
-   Sticky header + bottom navigation
-   Scroll-locked modals
-   Compact 3D carousel routine system
-   Compact log set modal with sticky header
-   Glass design system with deterministic layering

Optimized for: - iPhone PWA install - Offline resilience - Touch
performance

------------------------------------------------------------------------

# Deployment

1.  Update version.json
2.  Commit & deploy
3.  User taps "Reload to update"

No build tools required. No backend required. Static hosting ready.

------------------------------------------------------------------------

# Current Release

Version: 2.6 Build Date: 2026-02-16

------------------------------------------------------------------------

Built with production-level update control, schema safety, and
deterministic cache management.
