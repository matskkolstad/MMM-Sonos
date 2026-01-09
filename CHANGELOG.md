# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Fixed progress bar stuttering by eliminating unnecessary DOM re-renders (#26)
  - Added intelligent change detection to skip DOM updates when only progress changes
  - Progress bar now updates smoothly in-place without reconstruction
  - Detects user seeking with 3-second tolerance
  - Optimized CSS transition from 0.3s to 1s linear for smoother animation

### Changed
- Updated dependency overrides: `globals` 16.5.0 → 17.0.0, `eslint` 9.39.1 → 9.39.2, `@eslint/js` 9.39.1 → 9.39.2

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
