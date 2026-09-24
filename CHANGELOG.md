# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Touch control mode** (`enableControls: true`, by [@AndreasHagman](https://github.com/AndreasHagman) in #68) — tap a card to open a control overlay with play/pause, group volume, per-speaker volume, grouping/ungrouping of speakers and your Sonos favorites. Idle speakers are shown as cards (`controlShowIdleZones`) or behind a "+" tile. New options: `enableControls`, `controlShowIdleZones`, `favoritesRefreshInterval`, `maxFavorites`, `controlVolumeStep`. Off by default; nothing changes for existing setups.
- End-to-end test for touch control mode, and control actions in the Sonos simulator.

### Fixed
- **Playlist and album favorites did not start** in touch control mode ("could not reach speaker"). They are now played through the queue like in the Sonos app, and all favorites are sent with the metadata Sonos stores for them.
- **Paused cards flickered on every update** — a paused track's position stands still, which the module treated as a seek and re-animated the card each time. Affected paused cards with `showWhenPaused: true` as well.
- Sonos status placeholders such as `ZPSTR_CONNECTING` / `ZPSTR_BUFFERING` are no longer shown as "now playing" text while a stream starts.
- **Playlist favorites failed with UPnP 714 on regrouped speakers** — the queue was selected by the group ID, which Sonos keeps from the speaker that created the group. The speaker's own ID is now used.
- **Favorites did not load** when the first speaker found was a device that cannot list them (e.g. a Sub, surround speaker or Boost); the zone coordinators are tried next, and failed attempts are retried every 30 s instead of on every update.
- Failed control actions are now logged in the MagicMirror log, naming the step and favorite Sonos rejected.
- Favorites could take up to `favoritesRefreshInterval` (5 minutes) to appear when the speakers were not found yet at startup; they now load as soon as the speakers are found, and a browser that connects later gets them right away.
- The progress bar of a paused track no longer keeps counting up (#68).
- Missing translations fell back to Afrikaans (the first language listed) instead of English, showing raw keys such as `SPEAKERS` in languages without the new texts. English is now the fallback; the Norwegian translation is complete.

## [1.4.0] - 2026-09-24

### Added
- **Fullscreen mode** (`displayMode: 'fullscreen'`) — renders a single speaker's now-playing info as a large, full-width card with prominent album art (configurable via `fullscreenAlbumArtSize`, default: 300 px). Ideal for a dedicated MagicMirror page.
  - New `fullscreenSpeaker` option — pin the card to a specific speaker by name, group name, group ID, or coordinator IP; defaults to the first currently-playing group when `null`
  - New `fullscreenAlbumArtSize` option (default: `300`) — album art size in pixels for fullscreen mode
  - New `fullscreenWidth` option (default: `null`) — optional max-width constraint for the fullscreen wrapper
  - All standard display options (`showAlbum`, `showProgress`, `showVolume`, `showGroupMembers`, `albumArtColors`, `transitionAnimation`, etc.) work in fullscreen mode
- **Mini mode** (`displayMode: 'mini'`) — compact single-row cards showing a small thumbnail, group name badge, track title, and optional artist; ideal for a small corner of the display
  - New `miniAlbumArtSize` option (default: `40`) — thumbnail size in pixels
  - New `miniShowGroupName` option (default: `true`) — show room name badge
  - New `miniShowArtist` option (default: `true`) — append artist to title line
  - New `miniShowSource` option (default: `false`) — show source label (Spotify, Radio, etc.)
  - New `miniWidth` option (default: `null`) — constrain per-card width
- **Accent colours from album art** (`albumArtColors: true`) — dominant colour extracted from cached album art and applied as a tinted gradient on each card
  - New `albumArtColorsOpacity` option (default: `0.45`) — overlay opacity
  - New `albumArtColorsMode` option (`'gradient'` / `'solid'`) — gradient or flat tint
  - Requires `cacheAlbumArt: true`; uses [node-vibrant](https://github.com/Vibrant-Colors/node-vibrant) (new dependency)
- **Track-change transition animations** — cards animate when track info changes
  - New `transitionAnimation` option (`'fade'` / `'slide-up'` / `'slide-down'` / `'slide-left'` / `'slide-right'` / `'scale'` / `'zoom-in'` / `'zoom-out'` / `'flip'` / `'pixelate'` / `'none'`, default: `'fade'`)
  - New `transitionDuration` option (default: `400` ms)
  - Only the card whose track changed is animated in **all** display modes (mini, row, grid); other cards remain completely static
- **Whitelist filtering** — restrict the module to specific rooms/groups without listing every other room as hidden
  - New `allowedSpeakers` option — only show groups containing at least one listed room name
  - New `allowedGroups` option — only show groups matching a name, ID, or coordinator IP
- **Apple Music source detection and display** — streams from Apple Music are now correctly identified as `apple_music` and shown with the "Apple Music" label
- **Improved radio metadata** — station name, station logo, and live stream content ("now playing") are retrieved from the Sonos AVTransport `GetMediaInfo`/`GetPositionInfo` APIs for richer radio display
- **Radio art fallback** — a `/getaa` URL is built from the stream URI when no artwork is reported, giving a station logo in more cases
- **Album art image error handling** — broken image URLs now hide the art wrapper instead of showing a broken-image icon
- **`cardMaxWidth` option** (default: `null`) — sets a maximum width for each card, complementing `cardMinWidth`. Useful in row mode to prevent very wide cards when content is short and text wrapping is enabled. Example: `cardMaxWidth: 300` or `cardMaxWidth: '300px'`.
- **Album art local caching** - Album art images are now downloaded and cached locally for faster loading on slower networks
  - New `cacheAlbumArt` config option (default: `true`) to enable/disable caching
  - New `albumArtCacheTTL` config option (default: 30 days) — set to `0` to cache forever (no expiry)
  - New `clearCacheOnStart` config option (default: `false`) — wipes all cached images on module start
  - Cache is stored in `<module>/cache/album-art/` (auto-created, gitignored)
  - Files are served from `/modules/MMM-Sonos/cache/album-art/` by MagicMirror's static file server
  - Automatic cache cleanup removes files older than the configured TTL on every startup
  - `albumArtCacheTTL: 0` keeps images cached forever and skips cleanup entirely
  - Falls back gracefully to the original URL if caching fails
  - Support for on-demand cache clearing via `SONOS_CLEAR_CACHE` socket notification
  - Public `clearAlbumArtCache()` method callable from the browser console
- **Continuous integration** — a GitHub Actions workflow runs lint and unit tests on Node 22 and 24 for every push to `master` and every pull request, plus a dependency audit that fails on critical advisories.
- **Test suite** — unit tests (`npm test`) now load the real `node_helper.js` and `MMM-Sonos.js` instead of hand-copied functions (which had drifted from the real code), plus integration tests that run `node_helper` and the `sonos` package against a **Sonos simulator**, and an **end-to-end test** (`npm run test:e2e`) that runs the module in a real MagicMirror² with four display modes in headless Chromium and saves screenshots. See `test/README.md`.

### Changed
- **Far fewer requests to the Sonos system** — each module instance requested data on its own timer in addition to `node_helper`'s own timer, and every request polled all speakers again. With four instances that was about 105 SOAP calls every 5 seconds for a 5-room setup; it is now 17. Requests are answered from data younger than `updateInterval`, overlapping refreshes are merged into one, and the position/duration already returned with the current track is reused instead of being fetched a second time per group.
- **`wrapText: true` + `maxTextLines` now works correctly in row mode** — cards in row mode now use a fixed width equal to `cardMinWidth` (instead of growing freely to fit content). This means long titles wrap to `maxTextLines` lines as intended, rather than extending the card horizontally.
- **`showPlaybackState` badge is now shown on the same line as the speaker name** — previously the state ("Playing", "Paused") appeared below the name in a separate row; it is now displayed inline to the right of the name.
- **Track changes only animate the affected card** — transitions between playing-like states (PLAYING ↔ TRANSITIONING ↔ BUFFERING) during a track change no longer trigger a full module re-render. Only the card whose track actually changed animates.
- **Full-module animation is debounced** — rapid successive data updates (e.g. on page load or media change) are now collapsed into a single animation, preventing the 2–3 reload flashes previously seen.
- **Eliminated double-refresh on reconnect** — `node_helper._configure()` previously called `_refresh()` twice when the coordinator was already known (once immediately, once at the end of the function). The duplicate call is now skipped.
- Per-card track-change animation now works correctly in **all** display modes including `fullscreen`; only the affected card animates — structural changes still trigger a full re-render
- `--mmm-sonos-gap` default increased from `0.65rem` to `0.75rem` for slightly more breathing room between cards in row and grid modes
- Card `flex-basis` is no longer set via inline style — the CSS class (`flex: 1 1 var(--mmm-sonos-card-min)`) now controls it in all non-row modes. In row mode (`flex: 0 0 auto`) this prevents long titles from overflowing a fixed-width card and visually overlapping adjacent cards.
- README updated: Highlights, Configuration Examples, Configuration table, and Additional features reflect fullscreen mode and all new options
- `_detectSource` now checks URI patterns before `track.type` (more reliable); generic types `'track'` and `'audio'` are ignored as they do not carry useful source info
- `_isHidden` now also checks `coordinatorHost` against `hiddenSpeakers`, supports `allowedGroups` and `allowedSpeakers` whitelists, and is covered by unit tests
- `displayMode` now accepts `'mini'` in addition to `'auto'`, `'grid'`, and `'row'`
- Group data emitted by `node_helper` now includes `coordinatorHost`, `stationName`, and `streamTitle` fields
- Per-card track-change animation now works in **all** display modes (mini, row, grid); only the affected card animates — structural changes still trigger a full re-render
- Volume changes no longer trigger a track-change animation; the volume label updates silently in-place
- Album art images now use `loading="eager"` so they start loading immediately when inserted into the DOM, reducing the blank-art flash during track transitions
- New album art is preloaded (via `new Image()`) during the out-animation phase so the image is browser-cached when the new card appears
- README updated: Highlights, Complete Configuration example, Configuration table, and Additional features all reflect the new options

### Fixed
- **Track title missing for Apple Music and Amazon Music (#53)** — on-demand tracks from these services (track URIs starting with `x-sonosapi-hls-static:`) were detected as radio, so the album name was shown in place of the track title (and twice with `showAlbum: true`). Only real radio stream URIs are treated as radio now, and Apple Music/Spotify are also recognised by their Sonos service id. Local files whose path contains "/radio" (e.g. *Radiohead*) are no longer detected as radio either.
- **Fullscreen mode showed "No speakers are visible" with `allowedSpeakers`/`hiddenSpeakers`** — the fullscreen card always used the first group (alphabetically), even when that group was filtered out for the instance, so nothing was shown although an allowed speaker was playing. It now picks the first group the instance actually shows (and skips paused groups unless `showWhenPaused` is on). A pinned `fullscreenSpeaker` is still honoured.
- **`maxGroups` counted hidden and paused groups** — the limit was applied before the per-instance filters (and additionally in `node_helper`), so hidden groups could use up the slots and push allowed groups out. The limit is now applied after filtering, per instance.
- **Settings of one module instance switched features off for another** — all MMM-Sonos instances share one `node_helper`, which only kept the config it received last. With e.g. a row instance and a fullscreen instance, `albumArtColors`, `showWhenPaused` and `hiddenSpeakers`/`hiddenGroups` from one instance applied to all of them, depending on load order. `node_helper` now remembers each instance's config and combines them (a feature is fetched if any instance enables it; a speaker is dropped only if every instance hides it). Each instance still applies its own filters.
- **Stale cards and a `replaceChild` error after the playing set changed** — when a group stopped or appeared, the full re-render was debounced, but every new data update restarted the timer while per-card updates kept patching the old DOM. The old card could stay visible for several update cycles, and a per-card swap could throw `Failed to execute 'replaceChild'` once the full render replaced the card. A scheduled re-render is no longer postponed, data that arrives while it is pending or animating is rendered afterwards, and per-card swaps skip cards that were already replaced.
- **Album art downloads could hang a refresh** — downloads now time out after 10 seconds, follow relative redirects, and never leave partial files behind.
- **Room name lookup never ran** — `_inferCoordinatorName()` treated the `deviceDescription` method as the description itself. It now fetches the description, and only when the group data has no name.
- Radio streams that report the end of the stream URL as title (e.g. `P04_MM?args=3rdparty_03` for P4 via myTuner) no longer show it when the station name is unknown.
- After a failed refresh, the next data request polls the speakers again instead of replaying the last successful data (which also hid the error).
- `node_helper` no longer logs the complete configuration on every (re)connect; it is logged only with `debug: true`.
- **Dual-mode independence** — each module instance now scopes all in-place DOM operations (per-card animation, progress bar updates, volume updates) to its own wrapper via `data-module-id`. Previously, `document.querySelector` would find elements from the first matching instance in the document, causing cross-instance interference.
- **Grid/auto mode card overlap:** In `grid` and `auto` (when resolving to grid) display modes, cards overflowed their grid cells and overlapped adjacent cards. Root cause: `.mmm-sonos--mode-grid .mmm-sonos__group { width: 100% }` used the default `box-sizing: content-box`, making the total rendered card width equal to the grid column width *plus* both horizontal padding values (2 × 0.65 rem ≈ 20.8 px). With `justify-items: center`, each card extended 0.65 rem beyond its cell on each side; since the grid gap is only 0.75 rem, neighbouring cards overlapped by ~0.55 rem (~8.8 px). Fixed by adding `box-sizing: border-box` to `.mmm-sonos--mode-grid .mmm-sonos__group` so padding is included in the `width: 100%` calculation.
- **Normal mode + mini mode dual-instance bug (Issues 1 & 2):** When both a normal-mode and a mini-mode instance were active simultaneously, `document.querySelector('[data-group-id="..."]')` found the first matching element in the entire document instead of the element belonging to the calling instance. This caused the normal-mode instance to replace mini-mode cards with full-size cards on track changes (mini grew to normal size), and left the normal-mode cards stale (no visible track-change update). Fixed by scoping all in-place DOM queries to `[data-module-id]`, a unique attribute set on each module wrapper in `getDom()`.
- **Slow initial load (Issue 3):** When the frontend reconnected and sent `SONOS_CONFIG`, `node_helper._configure()` always ran a full 5-second Sonos re-discovery even if a coordinator was already known from the startup phase. Now, if a coordinator is already set, data is served immediately and re-discovery runs silently in the background, eliminating the startup stall.
- **Layout overlap in row/grid mode (Issue 4):** Setting `container.style.flexBasis` to the card's `cardMinWidth` as an inline style overrode the mode-specific CSS `flex` shorthand. In row mode (`flex: 0 0 auto`, which sets `flex-basis: auto`), the inline override fixed the card at exactly 150 px; content wider than that (long titles, artist names) overflowed the card boundary and visually overlapped the adjacent card. Removed the inline `flexBasis` override so the CSS controls flex behaviour correctly in every mode.
- Removed duplicate `_shouldUpdateDom` method definition that caused an ESLint `no-dupe-keys` error
- Fixed unnecessary regex escape `\/` in `_parseDIDL` (ESLint `no-useless-escape`)
- Fixed progress bar stuttering by eliminating unnecessary DOM re-renders
  - Added intelligent change detection to skip DOM updates when only progress changes
  - Progress bar now updates smoothly in-place without reconstruction
  - Detects user seeking with 3-second tolerance
- Fixed spurious animations when only volume changes (e.g. automated volume adjustments)
- Fixed all speakers animating when only one speaker's track changes in row/grid mode
- Fixed progress bar not appearing when a track first starts (position reported as `0:00:00`)
  - A position of `0:00:00` is now treated as `0` instead of unknown; only `NOT_IMPLEMENTED` (no position support) means unknown
  - `_renderGroup` now shows the progress bar as long as `duration > 0`, even when `position` is `null` or `0`
  - `_updateProgressDataFromServer` now updates the bar dataset for `position = 0` and uses a class-agnostic selector so it works in both regular and mini display modes

### Security
- Applied non-breaking `npm audit` fixes to the lockfile (axios 1.13.1 → 1.20.0, follow-redirects, form-data, brace-expansion).

## [1.3.0] - 2026-01-08

### Added
- **Playback source indicator** - Shows source icons for Spotify, Radio, and Line-in (#24)
  - Configurable with `showPlaybackSource` (default: true)
  - Source-specific translations in English and Norwegian
- **Track progress display** - Visual progress bar with time counter (#24)
  - Shows current position and total duration (e.g., "2:45 / 5:55")
  - Configurable with `showProgress` (default: true)
  - Client-side interpolation for smooth 1-second updates between server polls
- **Volume display** - Shows current volume level for each speaker/group (#24)
  - Configurable with `showVolume` (default: true)
- **TV icon support** - Configurable TV icon modes for Sonos products (#21)
  - Added TV icon assets with multiple display modes

### Fixed
- Removed emoji icons from playback source and volume features for cleaner appearance (#25)
- Fixed progress bar animation to update smoothly instead of jumping every 15 seconds (#25)

### Changed
- Improved README with graduated configuration examples (minimal, common, complete) (#23)
- Added module structure documentation covering all files and translation system (#23)
- Updated screenshot to reflect current module appearance

## [1.2.0] - 2025-11-19

### Fixed
- Fixed CSS loading bug on Raspberry Pi 5 with Node v24.11.1 (#16)
  - CSS path now uses relative path wrapped in `this.file()` method
  - Fixes MIME type error that prevented CSS from loading

### Changed
- Merged dependency updates: `eslint` 9.38.0 → 9.39.1, `@eslint/js` 9.38.0 → 9.39.1, `globals` 16.4.0 → 16.5.0 (#12, #14, #15)
- Created PR merge safety analysis documentation (#17)

### Security
- Updated `sonos` dependency from 1.14.1 to 1.14.2 (#18)

## [1.1.0] - 2025-10-31

### Added
- **`textSize` configuration option** - Direct pixel-based control for text size (#9)
  - Overrides `fontScale` when specified
  - Implemented via CSS custom property `--mmm-sonos-text-size`
- **Configurable TV icon modes** - Support for displaying TV icons on Sonos products

### Fixed
- Fixed `textSize` and `fontScale` returning 0px when null (#10)
  - Added null guard in `_coercePixelValue()` before numeric conversion
  - Text now renders correctly with custom sizes
- Fixed `fontScale` CSS behavior to properly scale all text elements (#8)
  - Changed font sizes from `rem` to `em` units for proper scaling
  - Removed fixed `text-align` overrides to respect JavaScript-controlled alignment
- Fixed `textAlignment` configuration for left/center/right layouts (#6, #8, #9)
  - Center: Vertical layout (album art above, text below)
  - Left: Horizontal layout (text left-aligned, album art right)
  - Right: Horizontal layout (album art left, text right-aligned)
  - Text now properly "hugs" album art in horizontal layouts
- Fixed inverted default values (#7):
  - `showWhenPaused`: true → false (hide paused groups by default)
  - `hideWhenNothingPlaying`: false → true (hide module when nothing playing)

### Changed
- Migrated ESLint from v8 to v9 with flat config format (#5)
  - Removed deprecated `.eslintrc.json`
  - Added `eslint.config.js` with `@eslint/js` and `globals` packages
- Updated `axios` override from ^1.12.0 to ^1.13.1 for security fixes (#5)
- Updated test script message from Norwegian to English (#5)

### Security
- Updated security dependencies via overrides (#5):
  - `axios` ^1.12.0 → ^1.13.1 (fixes CSRF, SSRF, DoS vulnerabilities)
  - `xml2js` and `ip` remain current
- CodeQL security scan implemented with 0 alerts

## [1.0.1] - 2025-10-15

### Added
- ESLint 8.57.1 as dev dependency with npm scripts:
  - `npm run lint` - Run ESLint on all JavaScript files
  - `npm run audit` - Check for security vulnerabilities
- Development section in README with npm script documentation (#1)
- Security Notes section in README explaining dependency overrides (#1)

### Fixed
- Fixed 4 security vulnerabilities in transitive dependencies (#1):
  - **axios**: 0.21.4 → ^1.12.0 (CSRF, SSRF, DoS vulnerabilities)
  - **xml2js**: 0.4.23 → ^0.6.2 (prototype pollution vulnerability)
  - **ip**: 1.1.9 → ^2.0.1 (latest version, one known unfixed SSRF vulnerability)

### Changed
- Added Copilot Coding Agent instructions (#3)
- Translated documentation and logs from Norwegian to English
- Added repository metadata (package.json fields)
- Added publishing essentials (CODE_OF_CONDUCT.md)

### Security
- Documented known remaining vulnerability in `ip` package (GHSA-2p57-rm9w-gvfp)
  - No upstream patch available
  - Users should assess network security risk in their environment

## [1.0.0] - 2025-10-07

### Added
- Initial public release of `MMM-Sonos` with automatic Sonos discovery, layout options, and configurable display preferences
- Core features:
  - Automatic Sonos device discovery on local network
  - Real-time playback status with album art
  - Multiple display modes (row, grid, auto)
  - Configurable layout options (columns, alignment, text wrapping)
  - Group member display
  - Playback state indicators
  - Hidden speakers/groups filtering
  - Text size and font scaling
  - Theme customization via CSS variables
  - Norwegian and English translations
  - Static IP fallback for discovery
  - Debug mode for troubleshooting
