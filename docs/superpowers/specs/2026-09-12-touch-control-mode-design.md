# MMM-Sonos: Touch Control Mode

**Date:** 2026-09-12
**Status:** Approved design, ready for implementation planning

## Problem

MMM-Sonos is currently a pure display module: it polls Sonos zones, filters
out anything not playing (unless `showWhenPaused` is set), and renders
now-playing cards. There is no way to control playback from the module —
volume, play/pause, and source selection all happen only in the Sonos app.

The long-term goal is to run **one MMM-Sonos codebase** in two contexts:

1. **The existing mirror** — passive display, unchanged from today.
2. **A future dedicated touch-screen control device** — the same module,
   but showing every speaker on the network (not just ones currently
   playing) and letting the user tap a speaker to control it directly.

This design covers the second context, gated entirely behind a config flag
so the first context never changes behavior.

## Non-goals (out of scope for this iteration)

- Per-member volume within a group (group volume only).
- Touch controls in `mini` or `fullscreen` display modes (only `row` and
  `grid`).
- A custom, config-defined favorites/station list (favorites come only
  from Sonos' own saved favorites via `getFavorites()`).
- A second module instance / second discovery loop for the future
  touch-screen device (deferred — this design only adds the capability;
  wiring up a second physical device is a separate future task).

## Design

### Guiding constraint

`enableControls` (config, default `false`) is the single switch. When
`false`, every existing code path — filtering, rendering, polling — must
behave byte-for-byte as it does today. All new behavior described below is
additive and only reachable when `enableControls: true`.

### Backend (`node_helper.js`)

- **Zone filtering:** today, zones that are not playing (and not allowed
  by `showWhenPaused`) are dropped before sending `SONOS_DATA`. When
  `enableControls: true`, this filtering is skipped — every zone
  `getAllGroups()` reports is sent, each with an explicit
  `state: "playing" | "paused" | "stopped"` field. `hideWhenNothingPlaying`
  and `showWhenPaused` are ignored in this mode (there is nothing to hide
  — every zone is a control target).
- **Favorites:** on its own timer, independent of the now-playing poll
  loop — every `favoritesRefreshInterval` ms, plus once immediately after
  startup/discovery — call `coordinator.getFavorites()` and cache the
  result in memory. Send it to the frontend as its own message,
  `SONOS_FAVORITES`, rather than embedding it in every `SONOS_DATA` tick
  (favorites change rarely; now-playing data changes often).
- **New incoming socket notifications** (only registered/handled when
  `enableControls: true` for that module instance):
  - `SONOS_CONTROL_PLAY { zoneId }`
  - `SONOS_CONTROL_PAUSE { zoneId }`
  - `SONOS_CONTROL_SET_VOLUME { zoneId, volume }`
  - `SONOS_CONTROL_PLAY_FAVORITE { zoneId, favoriteId }`
  - Each handler resolves `zoneId` to a known coordinator host from the
    last discovery result, instantiates `new Sonos(host)` (the same
    pattern already used elsewhere in `node_helper.js`), and calls the
    corresponding method from the `sonos` package (`.play()`, `.pause()`,
    `.setVolume()`, a queue/select-track call for favorites).
  - Every handler replies with `SONOS_CONTROL_RESULT { zoneId, action,
    success, error? }` so the frontend never has to assume success.

### Frontend (`MMM-Sonos.js`)

- **Config additions** (all optional, all no-ops when `enableControls` is
  `false`):
  ```javascript
  enableControls: false,             // Master switch for touch control mode
  favoritesRefreshInterval: 300000,  // How often favorites are re-fetched (ms)
  maxFavorites: 12,                  // Max favorites shown before scrolling
  controlVolumeStep: 5,              // Step size for any +/- volume affordance
  ```
- **Idle/stopped zone cards:** when `enableControls: true`, zones with
  `state: "stopped"` render a simple placeholder card (zone name, a
  "muted"/quiet icon in place of album art, current volume). No progress
  bar, no track metadata.
- **Card interactivity:** in `row` and `grid` display modes only, cards
  get a click handler when `enableControls: true`. Clicking any card
  (playing or idle) opens the control overlay for that zone.
- **Control overlay component:**
  - Header: zone/group name.
  - Play/pause toggle (large, centered); shows a "play" affordance when
    idle.
  - One group-volume slider. Updates local/optimistic state immediately
    while dragging; sends `SONOS_CONTROL_SET_VOLUME` debounced (~150ms
    after the last drag movement) rather than on every pixel of movement.
  - Favorites list below: radio-button style, name + a small icon
    indicating type (radio stream vs. playlist/track), scrollable past
    `maxFavorites`. The entry matching the currently-playing source (by
    title/URI) is marked selected. Clicking an entry sends
    `SONOS_CONTROL_PLAY_FAVORITE`.
  - Closes on outside click or a close ("×") control.
  - Subscribes to the module's existing `SONOS_DATA` stream so it stays
    in sync if the zone's state changes from outside (e.g., someone uses
    the Sonos app while the overlay is open).

### Error handling

- **Command failure** (offline speaker, UPnP timeout, wrong host): backend
  catches the exception and replies with `SONOS_CONTROL_RESULT { success:
  false, error }`. The overlay shows a short inline error ("Kunne ikke nå
  Kjøkkenhøyttaler") instead of silently doing nothing.
- **Zone disappears while overlay is open** (speaker powered off): the
  next `SONOS_DATA` tick no longer contains that zone id → the overlay
  auto-closes with a brief message, instead of showing a dead panel.
- **No favorites saved in Sonos:** favorites list renders an empty state
  ("Ingen favoritter funnet — legg til i Sonos-appen") instead of a blank
  gap.
- **Volume drag races an in-flight command:** only the latest
  `SONOS_CONTROL_SET_VOLUME` request is honored (debounce ensures at most
  one in flight per drag gesture), so a fast drag never produces a queue
  of stale volume commands that snap the slider backward after the fact.

### Testing

- Backend unit tests (extending `test/node_helper.test.js`, mocking the
  `Sonos` client):
  - `SONOS_CONTROL_PLAY` / `PAUSE` / `SET_VOLUME` / `PLAY_FAVORITE`
    handlers: success case and failure case (mocked rejection → `success:
    false` result).
  - Regression test: with `enableControls: false`, `_discover()`'s output
    is unchanged from current behavior (this is the concrete guarantee
    that the mirror's display never changes).
  - With `enableControls: true`, idle/paused zones are included in the
    output sent to the frontend.
- Frontend tests (new, matching whatever test setup already covers
  `MMM-Sonos.js`, if any — otherwise plain unit tests around the overlay
  module in isolation):
  - Overlay opens/closes correctly and renders the tapped zone's data.
  - Correct notification payloads are sent for play/pause/volume/favorite
    interactions.
- Manual verification: run the module with `enableControls: true` against
  the real Sonos system on the network and exercise play/pause/volume/
  favorite selection end-to-end.

## Open questions for a later iteration (explicitly deferred)

- Per-speaker volume within a group.
- Touch support in `mini`/`fullscreen` modes.
- Config-defined favorites whitelist/filtering on top of Sonos favorites.
- Running this in `enableControls: true` mode on a second, dedicated
  physical device/instance.
