# Testing MMM-Sonos

There are two layers of tests. Both run in CI on every pull request.

## Unit tests (`npm test`)

Fast tests for `node_helper.js` and `MMM-Sonos.js`. They load the **real**
module files through `test/helpers/load-module.js`:

- `node_helper.js` is required with MagicMirror's `node_helper` and `logger`
  modules replaced by stubs.
- `MMM-Sonos.js` is evaluated in a sandbox that captures the object passed to
  `Module.register()`.

Test files: `test/node_helper.test.js`, `test/frontend.test.js`.

## End-to-end test (`npm run test:e2e`)

Runs the module the way it runs on a mirror:

1. `test/e2e/setup.js` installs a real MagicMirror² (server only) and
   `playwright-core` into `.e2e/` (git-ignored). This happens once; later runs
   reuse it.
2. `test/e2e/fake-sonos.js` starts simulated Sonos speakers on
   `127.0.0.1:1400-1405`. They answer the same UPnP/SOAP calls as real speakers,
   so `node_helper.js` and the `sonos` package run unmodified.
3. MagicMirror² starts with four MMM-Sonos instances (row, grid, mini and
   fullscreen) and headless Chromium opens it.
4. The test checks what each instance shows, switches the simulated speakers to
   other tracks and checks that the page updates without a reload.

Screenshots of every instance are written to `test/e2e/output/`. In CI they are
uploaded as the `e2e-screenshots` artifact.

Requirements: Node 22 or 24, git, network access for the first setup, and a
Chromium or Chrome binary. The binary is auto-detected; set `CHROMIUM_PATH` if
it is somewhere else. `MM_VERSION` selects the MagicMirror² tag.

### Scenarios

`test/e2e/scenarios/*.json` describe speakers, groups and what they play. The
track URIs follow the formats real Sonos systems report for each service
(Spotify, Apple Music, Amazon Music, TuneIn, Sonos Radio, TV, local library).
To add a case, add or edit a scenario and assert on it in `mirror.e2e.js`.

### Running the simulator by hand

```bash
npm run sim -- test/e2e/scenarios/mixed-sources.json
```

Then point a MagicMirror² instance at it with
`knownDevices: ['127.0.0.1'], discoveryTimeout: 0`.
