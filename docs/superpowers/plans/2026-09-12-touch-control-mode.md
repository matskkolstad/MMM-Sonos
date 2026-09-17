# Touch Control Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a config-gated touch control layer to MMM-Sonos that always shows every Sonos zone (playing or idle) and lets the user tap a zone to play/pause it, adjust its group volume, and pick a Sonos favorite — without changing anything about the module's existing passive display behavior.

**Architecture:** A single new config flag, `enableControls` (default `false`), gates every change in this plan. When it is `false`, every touched code path must produce byte-identical output/behavior to today. When `true`: the backend (`node_helper.js`) stops filtering out idle/paused zones and exposes new control notifications; the frontend (`MMM-Sonos.js`) renders idle zones as simple placeholder cards, makes `row`/`grid` cards clickable, and opens a body-level overlay (independent of MagicMirror's own DOM-replacement cycle) with play/pause, a volume slider, and a favorites list.

**Tech Stack:** Plain JavaScript (no framework), the `sonos` npm package (already a dependency), MagicMirror's `NodeHelper`/`Module.register` APIs, Node's built-in test runner (`node --test`), plain CSS (no preprocessor).

**Spec:** `docs/superpowers/specs/2026-09-12-touch-control-mode-design.md`

## Global Constraints

- `enableControls` defaults to `false`. Every task that changes shared code paths (`_mapGroups`, `_renderGroup`) must preserve byte-identical behavior when it is `false` — verified by a regression test, not just by inspection.
- Touch controls apply only to `row` and `grid` display modes. `mini` and `fullscreen` are untouched by this plan.
- The favorites list comes only from `coordinator.getFavorites()` (real Sonos-app favorites). No config-defined custom station list.
- "Group volume" means: dragging the one slider sets every member speaker in that zone to the same absolute volume value (resolved via each member's own host, not just the coordinator). It does not expose per-member sliders.
- This plan does not add a second `MMM-Sonos` instance or a second discovery loop.
- Follow existing test conventions in this module: `test/node_helper.test.js` unit-tests pure/stateless logic via inline copies of the real functions (no network, no MagicMirror runtime, no mocked UPnP calls). Real I/O (discovery, actual Sonos control calls, DOM/overlay behavior) is verified manually against the live system, not through automated tests — this plan follows that same line, and says explicitly, per task, which parts get an automated test and which get manual verification.

---

### Task 1: Backend — always include idle/paused zones when `enableControls` is on

**Files:**
- Modify: `node_helper.js:54-77` (config defaults in `_configure`), `node_helper.js:291-310` (zone filtering in `_mapGroups`)
- Test: `test/node_helper.test.js`

**Interfaces:**
- Consumes: nothing new (works with existing `this.config`, `state`, `isTvSource` already computed at that point in `_mapGroups`).
- Produces: `this.config.enableControls` (boolean, default `false`) available to every later task. When `true`, `_mapGroups` includes every zone from `getAllGroups()` regardless of playback state.

- [ ] **Step 1: Write the failing tests**

Add to `test/node_helper.test.js`, right after the existing `_isHidden()` describe block (matching the file's existing "pure copy of the real logic" pattern used for every other helper):

```javascript
// Pure copy of the zone-inclusion logic from node_helper.js `_mapGroups()`,
// extracted for unit testing (mirrors the `_isHidden` pattern above).
function _shouldIncludeZone(state, isTvSource, config) {
  const allowWhenPaused = config.showWhenPaused || isTvSource || config.enableControls;
  if (state !== 'playing' && !allowWhenPaused) {
    return false;
  }
  if (state === 'stopped' && config.hideWhenNothingPlaying && !isTvSource && !config.enableControls) {
    return false;
  }
  return true;
}

describe('_shouldIncludeZone()', () => {
  const defaultConfig = { showWhenPaused: false, hideWhenNothingPlaying: true, enableControls: false };

  it('excludes a stopped zone by default (regression: current behavior)', () => {
    assert.equal(_shouldIncludeZone('stopped', false, defaultConfig), false);
  });

  it('excludes a paused zone by default (regression: current behavior)', () => {
    assert.equal(_shouldIncludeZone('paused', false, defaultConfig), false);
  });

  it('includes a playing zone by default (regression: current behavior)', () => {
    assert.equal(_shouldIncludeZone('playing', false, defaultConfig), true);
  });

  it('includes a paused zone when showWhenPaused is set (regression: current behavior)', () => {
    assert.equal(_shouldIncludeZone('paused', false, { ...defaultConfig, showWhenPaused: true }), true);
  });

  it('always includes a TV source zone (regression: current behavior)', () => {
    assert.equal(_shouldIncludeZone('stopped', true, defaultConfig), true);
  });

  it('includes a stopped zone when enableControls is true', () => {
    assert.equal(_shouldIncludeZone('stopped', false, { ...defaultConfig, enableControls: true }), true);
  });

  it('includes a paused zone when enableControls is true', () => {
    assert.equal(_shouldIncludeZone('paused', false, { ...defaultConfig, enableControls: true }), true);
  });

  it('includes a playing zone when enableControls is true', () => {
    assert.equal(_shouldIncludeZone('playing', false, { ...defaultConfig, enableControls: true }), true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd modules/MMM-Sonos && npm test`
Expected: the new `_shouldIncludeZone()` tests all PASS already (it's a pure standalone function, not yet wired to real code) — this step is actually verifying the *real* `node_helper.js` doesn't yet honor `enableControls`. Confirm that by temporarily grepping `node_helper.js` for `enableControls` — it should have zero matches before Step 3.

Run: `grep -n "enableControls" node_helper.js`
Expected: no output (confirms the real code doesn't implement this yet).

- [ ] **Step 3: Implement in `node_helper.js`**

In `_configure()`, add `enableControls: false,` to the defaults object (`node_helper.js:54-77`), e.g. right after `hideWhenNothingPlaying: true,`:

```javascript
        hideWhenNothingPlaying: true,
        enableControls: false,
```

In `_mapGroups()`, replace the two filtering lines (`node_helper.js:299-310`):

```javascript
        const allowWhenPaused = this.config.showWhenPaused || isTvSource;
        if (state !== 'playing' && !allowWhenPaused) {
          this.sendDebug('Skipping group because it is not playing (and not allowed when paused)', name || id, state, {
            isTvSource
          });
          continue;
        }

        if (state === 'stopped' && this.config.hideWhenNothingPlaying && !isTvSource) {
          this.sendDebug('Hiding stopped group because hideWhenNothingPlaying is enabled', name || id);
          continue;
        }
```

with:

```javascript
        const allowWhenPaused = this.config.showWhenPaused || isTvSource || this.config.enableControls;
        if (state !== 'playing' && !allowWhenPaused) {
          this.sendDebug('Skipping group because it is not playing (and not allowed when paused)', name || id, state, {
            isTvSource
          });
          continue;
        }

        if (state === 'stopped' && this.config.hideWhenNothingPlaying && !isTvSource && !this.config.enableControls) {
          this.sendDebug('Hiding stopped group because hideWhenNothingPlaying is enabled', name || id);
          continue;
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd modules/MMM-Sonos && npm test`
Expected: PASS — all existing tests still pass (regression-safe) and the new `_shouldIncludeZone` tests pass.

- [ ] **Step 5: Commit**

```bash
git add node_helper.js test/node_helper.test.js
git commit -m "feat(sonos): include idle/paused zones when enableControls is set"
```

---

### Task 2: Backend — resolve per-member speaker hosts (needed for true group volume)

**Files:**
- Modify: `node_helper.js:233-471` (`_mapGroups`, adding a new `_resolveMemberHost` helper and a `memberHosts` field on each formatted group)
- Test: `test/node_helper.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: each object in the array returned by `_mapGroups` (and thus `this.lastPayload`) now also carries `memberHosts: Array<{ host: string, port: number }>` — one entry per member speaker in the zone, resolved from that member's own `Location` URL, falling back to `[{ host: coordinatorHost, port: 1400 }]` if no member locations could be parsed. Task 4 depends on this field.

- [ ] **Step 1: Write the failing test**

Add to `test/node_helper.test.js`:

```javascript
// Pure copy of the new `_resolveMemberHost()` helper from node_helper.js, for unit testing.
function _resolveMemberHost(member) {
  const location = member && (member.Location || member.location);
  if (!location) return null;
  try {
    const url = new URL(location);
    return { host: url.hostname, port: url.port ? parseInt(url.port, 10) : 1400 };
  } catch {
    return null;
  }
}

describe('_resolveMemberHost()', () => {
  it('parses host and port from a Location URL', () => {
    const result = _resolveMemberHost({ Location: 'http://192.168.1.50:1400/xml/device_description.xml' });
    assert.deepEqual(result, { host: '192.168.1.50', port: 1400 });
  });

  it('defaults to port 1400 when the URL has no explicit port', () => {
    const result = _resolveMemberHost({ Location: 'http://192.168.1.50/xml/device_description.xml' });
    assert.deepEqual(result, { host: '192.168.1.50', port: 1400 });
  });

  it('returns null when there is no Location field', () => {
    assert.equal(_resolveMemberHost({ ZoneName: 'Kitchen' }), null);
  });

  it('returns null for a malformed Location URL', () => {
    assert.equal(_resolveMemberHost({ Location: 'not-a-url' }), null);
  });

  it('accepts a lowercase location field', () => {
    const result = _resolveMemberHost({ location: 'http://10.0.0.17:1400/xml/device_description.xml' });
    assert.deepEqual(result, { host: '10.0.0.17', port: 1400 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd modules/MMM-Sonos && npm test`
Expected: these new tests PASS immediately (pure standalone function) — confirm the *real* `node_helper.js` has no `_resolveMemberHost` yet: `grep -n "_resolveMemberHost" node_helper.js` → no output.

- [ ] **Step 3: Implement in `node_helper.js`**

Add a new method (near `_resolveCoordinator`, e.g. directly after it, around `node_helper.js:500`):

```javascript
  _resolveMemberHost(member) {
    const location = this._pick(member, ['Location', 'location']);
    if (!location) {
      return null;
    }
    try {
      const url = new URL(location);
      return { host: url.hostname, port: url.port ? parseInt(url.port, 10) : 1400 };
    } catch (error) {
      this.sendDebug('Failed to parse member location', location, error?.message || error);
      return null;
    }
  },
```

In `_mapGroups()`'s member loop (`node_helper.js:269-280`), collect hosts alongside display names:

```javascript
      const members = [];
      const memberHosts = [];
      let skipGroup = false;

      for (const member of memberList) {
        const displayName = this._pick(member, ['roomName', 'name', 'ZoneName']);
        if (!displayName) {
          continue;
        }
        if (hiddenSpeakers.has(displayName.toLowerCase())) {
          this.sendDebug('Skipping group because member is hidden', displayName, name);
          skipGroup = true;
          break;
        }
        members.push(displayName);
        const memberHost = this._resolveMemberHost(member);
        if (memberHost) {
          memberHosts.push(memberHost);
        }
      }
```

(This replaces the existing `const members = []; let skipGroup = false;` declaration and loop body — same loop, two new lines.)

Then, in the `formatted.push({...})` call (`node_helper.js:446-464`), add the field:

```javascript
        formatted.push({
          id: id || coordinator.uuid || coordinator.host,
          name: name || coordinatorName || 'Sonos',
          coordinatorHost: coordinator.host || null,
          memberHosts: memberHosts.length ? memberHosts : (coordinator.host ? [{ host: coordinator.host, port: coordinator.port || 1400 }] : []),
          playbackState: state,
          title: displayTitle,
          artist: displayArtist,
          album: track?.album || null,
          albumArt,
          accentColor,
          source,
          isTvSource,
          stationName,
          streamTitle,
          volume,
          position,
          duration,
          members: members.length ? members : [coordinatorName || name || 'Sonos']
        });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd modules/MMM-Sonos && npm test`
Expected: PASS.

- [ ] **Step 5: Manual verification**

With the live system running (`npm run server` from the MagicMirror root, as already set up), set `debug: true` on the MMM-Sonos config block and check the server log for a `[MMM-Sonos] Sending groups:` line — confirm each group now has a `memberHosts` array with one `{host, port}` entry per speaker in that group (e.g. the "Kjøkkenhøyttaler + Badhøyttaler" group should show two entries).

- [ ] **Step 6: Commit**

```bash
git add node_helper.js test/node_helper.test.js
git commit -m "feat(sonos): resolve per-member speaker hosts for group volume control"
```

---

### Task 3: Backend — favorites fetching

**Files:**
- Modify: `node_helper.js` (`_configure`, `stop`, new `_refreshFavorites` method, `socketNotificationReceived`)
- Test: `test/node_helper.test.js`

**Interfaces:**
- Consumes: `this.coordinator.getFavorites()` (from the `sonos` package — confirmed shape: `{ items: [{ id, title, uri, ... }] }`, verified against the real device in Step 5 below).
- Produces: `this.favorites` (array of `{ id, title, uri }`, in-memory on the helper), and a `SONOS_FAVORITES` outgoing notification with payload `{ favorites, timestamp }` that Task 6 consumes.

- [ ] **Step 1: Write the failing test**

Add to `test/node_helper.test.js`:

```javascript
// Pure copy of the favorites-mapping logic from node_helper.js `_refreshFavorites()`.
function _mapFavorites(items) {
  return (items || [])
    .map((item, index) => ({
      id: item.id || `favorite-${index}`,
      title: item.title || 'Untitled',
      uri: item.uri
    }))
    .filter((f) => !!f.uri);
}

describe('_mapFavorites()', () => {
  it('maps title/uri/id fields', () => {
    const result = _mapFavorites([{ id: 'FV:2/0', title: 'NRK P3', uri: 'x-sonosapi-hls:p3' }]);
    assert.deepEqual(result, [{ id: 'FV:2/0', title: 'NRK P3', uri: 'x-sonosapi-hls:p3' }]);
  });

  it('drops favorites with no uri', () => {
    const result = _mapFavorites([{ id: 'a', title: 'Broken favorite' }]);
    assert.deepEqual(result, []);
  });

  it('falls back to an index-based id when missing', () => {
    const result = _mapFavorites([{ title: 'NRK P1', uri: 'x-sonosapi-hls:p1' }]);
    assert.equal(result[0].id, 'favorite-0');
  });

  it('falls back to "Untitled" when title is missing', () => {
    const result = _mapFavorites([{ uri: 'x-sonosapi-hls:p1' }]);
    assert.equal(result[0].title, 'Untitled');
  });

  it('returns an empty array for empty/undefined input', () => {
    assert.deepEqual(_mapFavorites([]), []);
    assert.deepEqual(_mapFavorites(undefined), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd modules/MMM-Sonos && npm test`
Expected: new tests PASS (pure function). Confirm the real helper doesn't exist yet: `grep -n "_refreshFavorites" node_helper.js` → no output.

- [ ] **Step 3: Implement in `node_helper.js`**

Add `favorites: [],` and `favoritesTimer: null,` to the instance state initialized in `start()` (alongside `this.lastPayload = [];`):

```javascript
    this.lastPayload = [];
    this.favorites = [];
    this.favoritesTimer = null;
```

Add the new method (e.g. directly after `_refresh()`):

```javascript
  async _refreshFavorites() {
    if (!this.coordinator) {
      return;
    }
    try {
      const result = await this.coordinator.getFavorites();
      this.favorites = (result?.items || [])
        .map((item, index) => ({
          id: item.id || `favorite-${index}`,
          title: item.title || 'Untitled',
          uri: item.uri
        }))
        .filter((f) => !!f.uri);
      this.sendSocketNotification('SONOS_FAVORITES', { favorites: this.favorites, timestamp: Date.now() });
    } catch (error) {
      this.sendDebug('Failed to fetch favorites', error?.message || error);
    }
  },
```

In `_configure()`, after the existing `updateTimer` block, start/stop the favorites timer based on `enableControls`:

```javascript
    if (this.config.enableControls) {
      if (!this.favoritesTimer) {
        this._refreshFavorites();
        this.favoritesTimer = setInterval(
          () => this._refreshFavorites(),
          Math.max(this.config.favoritesRefreshInterval || 300000, 60000)
        );
      }
    } else if (this.favoritesTimer) {
      clearInterval(this.favoritesTimer);
      this.favoritesTimer = null;
    }
```

Add `favoritesRefreshInterval: 300000,` to the config defaults object alongside `enableControls: false,`.

In `stop()`, clear the new timer too:

```javascript
  async stop() {
    this._clearTimer();
    if (this.favoritesTimer) {
      clearInterval(this.favoritesTimer);
      this.favoritesTimer = null;
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd modules/MMM-Sonos && npm test`
Expected: PASS.

- [ ] **Step 5: Manual verification against the real system**

With the live server running and `enableControls: true`, `debug: true` set on the MMM-Sonos config block, check the server log for a line logging the `SONOS_FAVORITES` payload (add a temporary `Log.log` inside `_refreshFavorites` if the existing `sendDebug` doesn't surface it clearly enough, then remove the temporary log once confirmed). Confirm the favorites list matches what's saved in the Sonos app, and note whether `item.uri` values look like usable stream URIs (e.g. `x-sonosapi-hls:...`, `x-rincon-cpcontainer:...`) — this confirms the shape assumed in Task 5 (playing a favorite) is correct before that task is implemented.

- [ ] **Step 6: Commit**

```bash
git add node_helper.js test/node_helper.test.js
git commit -m "feat(sonos): fetch and broadcast Sonos favorites when enableControls is set"
```

---

### Task 4: Backend — playback control notifications (play/pause/volume/favorite)

**Files:**
- Modify: `node_helper.js` (`socketNotificationReceived`, four new handler methods, one new lookup helper)
- Test: `test/node_helper.test.js`

**Interfaces:**
- Consumes: `this.lastPayload` (from Task 1/2 — each entry has `id`, `coordinatorHost`, `memberHosts`), `this.favorites` (from Task 3).
- Produces: handles incoming `SONOS_CONTROL_PLAY`, `SONOS_CONTROL_PAUSE`, `SONOS_CONTROL_SET_VOLUME`, `SONOS_CONTROL_PLAY_FAVORITE` (each `{ zoneId, ... }`); sends `SONOS_CONTROL_RESULT { zoneId, action, success, error }` for every one. Task 5/6 (frontend overlay) send the incoming notifications and consume the result.

- [ ] **Step 1: Write the failing test**

Add to `test/node_helper.test.js`:

```javascript
// Pure copy of the `_findZone()` lookup helper from node_helper.js.
function _findZone(lastPayload, zoneId) {
  return (lastPayload || []).find((z) => z.id === zoneId) || null;
}

describe('_findZone()', () => {
  const payload = [
    { id: 'zone-1', name: 'Kitchen' },
    { id: 'zone-2', name: 'Bedroom' }
  ];

  it('finds a zone by id', () => {
    assert.deepEqual(_findZone(payload, 'zone-2'), { id: 'zone-2', name: 'Bedroom' });
  });

  it('returns null when the zone id is not found', () => {
    assert.equal(_findZone(payload, 'zone-99'), null);
  });

  it('returns null for an empty payload', () => {
    assert.equal(_findZone([], 'zone-1'), null);
    assert.equal(_findZone(undefined, 'zone-1'), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd modules/MMM-Sonos && npm test`
Expected: new tests PASS (pure function). Confirm the real handlers don't exist yet: `grep -n "SONOS_CONTROL_PLAY" node_helper.js` → no output.

- [ ] **Step 3: Implement in `node_helper.js`**

Add the lookup helper and result sender (near `_resolveCoordinator`):

```javascript
  _findZone(zoneId) {
    return (this.lastPayload || []).find((z) => z.id === zoneId) || null;
  },

  _sendControlResult(zoneId, action, success, error) {
    this.sendSocketNotification('SONOS_CONTROL_RESULT', { zoneId, action, success, error: error || null });
  },
```

Add the four control handlers (near `_refreshFavorites`):

```javascript
  async _handlePlay(zoneId) {
    const zone = this._findZone(zoneId);
    if (!zone || !zone.coordinatorHost) {
      this._sendControlResult(zoneId, 'play', false, 'Zone not found');
      return;
    }
    try {
      await new Sonos(zone.coordinatorHost).play();
      this._sendControlResult(zoneId, 'play', true);
    } catch (error) {
      this._sendControlResult(zoneId, 'play', false, error?.message || String(error));
    }
  },

  async _handlePause(zoneId) {
    const zone = this._findZone(zoneId);
    if (!zone || !zone.coordinatorHost) {
      this._sendControlResult(zoneId, 'pause', false, 'Zone not found');
      return;
    }
    try {
      await new Sonos(zone.coordinatorHost).pause();
      this._sendControlResult(zoneId, 'pause', true);
    } catch (error) {
      this._sendControlResult(zoneId, 'pause', false, error?.message || String(error));
    }
  },

  async _handleSetVolume(zoneId, volume) {
    const zone = this._findZone(zoneId);
    if (!zone) {
      this._sendControlResult(zoneId, 'setVolume', false, 'Zone not found');
      return;
    }
    const targets = (zone.memberHosts && zone.memberHosts.length)
      ? zone.memberHosts
      : (zone.coordinatorHost ? [{ host: zone.coordinatorHost, port: 1400 }] : []);
    if (!targets.length) {
      this._sendControlResult(zoneId, 'setVolume', false, 'No reachable speakers in zone');
      return;
    }
    try {
      await Promise.all(targets.map((target) => new Sonos(target.host, target.port).setVolume(volume)));
      this._sendControlResult(zoneId, 'setVolume', true);
    } catch (error) {
      this._sendControlResult(zoneId, 'setVolume', false, error?.message || String(error));
    }
  },

  async _handlePlayFavorite(zoneId, favoriteId) {
    const zone = this._findZone(zoneId);
    if (!zone || !zone.coordinatorHost) {
      this._sendControlResult(zoneId, 'playFavorite', false, 'Zone not found');
      return;
    }
    const favorite = (this.favorites || []).find((f) => f.id === favoriteId);
    if (!favorite) {
      this._sendControlResult(zoneId, 'playFavorite', false, 'Favorite not found');
      return;
    }
    try {
      await new Sonos(zone.coordinatorHost).setAVTransportURI(favorite.uri);
      this._sendControlResult(zoneId, 'playFavorite', true);
    } catch (error) {
      this._sendControlResult(zoneId, 'playFavorite', false, error?.message || String(error));
    }
  },
```

Wire them into `socketNotificationReceived` (`node_helper.js:39-52`):

```javascript
  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case 'SONOS_CONFIG':
        this._configure(payload || {});
        break;
      case 'SONOS_REQUEST':
        this._refresh();
        break;
      case 'SONOS_CLEAR_CACHE':
        this._clearAlbumArtCache();
        this.sendSocketNotification('SONOS_CACHE_CLEARED', { timestamp: Date.now() });
        break;
      case 'SONOS_CONTROL_PLAY':
        this._handlePlay(payload?.zoneId);
        break;
      case 'SONOS_CONTROL_PAUSE':
        this._handlePause(payload?.zoneId);
        break;
      case 'SONOS_CONTROL_SET_VOLUME':
        this._handleSetVolume(payload?.zoneId, payload?.volume);
        break;
      case 'SONOS_CONTROL_PLAY_FAVORITE':
        this._handlePlayFavorite(payload?.zoneId, payload?.favoriteId);
        break;
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd modules/MMM-Sonos && npm test`
Expected: PASS.

- [ ] **Step 5: Manual verification against the real system**

With `enableControls: true` and the live server running, use the browser devtools console on the running mirror page (or a small temporary script) to call:
```javascript
MM.getModules().withClass('MMM-Sonos')[0].sendSocketNotification('SONOS_CONTROL_PAUSE', { zoneId: '<a real zone id from the SONOS_DATA log>' });
```
and confirm the actual speaker pauses, then repeat for play, a volume value, and a favorite id from the Task 3 log. Confirm `SONOS_CONTROL_RESULT` appears in the socket notification log with `success: true` for each.

- [ ] **Step 6: Commit**

```bash
git add node_helper.js test/node_helper.test.js
git commit -m "feat(sonos): add play/pause/volume/favorite control notification handlers"
```

---

### Task 5: Frontend — config defaults and idle-zone cards (row/grid only)

**Files:**
- Modify: `MMM-Sonos.js:4-68` (defaults), `MMM-Sonos.js:327-626` (`_renderGroup`)

**Interfaces:**
- Consumes: `group.playbackState` (already present), `this.config.enableControls`/`showWhenPaused` (new/existing config).
- Produces: `_renderGroup` no longer returns `null` for an idle zone when `enableControls` is `true` — instead renders a placeholder card with class `mmm-sonos__group--idle`. Task 6 attaches click handling to every card `_renderGroup` produces (idle or playing) when `enableControls` is `true`.

- [ ] **Step 1: Add config defaults**

In `MMM-Sonos.js`'s `defaults` object (`MMM-Sonos.js:4-68`), add near `hideWhenNothingPlaying`:

```javascript
    enableControls: false,
    favoritesRefreshInterval: 300000,
    maxFavorites: 12,
    controlVolumeStep: 5,
```

- [ ] **Step 2: Modify `_renderGroup` to render idle cards**

In `_renderGroup` (`MMM-Sonos.js:327-341`), change:

```javascript
    const playbackState = (group.playbackState || '').toLowerCase();
    const isPlaying = ['playing', 'transitioning', 'buffering'].includes(playbackState);
    if (!isPlaying && !this.config.showWhenPaused) {
      return null;
    }
```

to:

```javascript
    const playbackState = (group.playbackState || '').toLowerCase();
    const isPlaying = ['playing', 'transitioning', 'buffering'].includes(playbackState);
    const isIdleControlCard = this.config.enableControls && !isPlaying && !this.config.showWhenPaused;
    if (!isPlaying && !this.config.showWhenPaused && !this.config.enableControls) {
      return null;
    }
```

Further down, the album-art block (`MMM-Sonos.js:410` through the closing `}` at `MMM-Sonos.js:489`) is a plain `if (group.albumArt) { ... } else if (isTvSource) { ... }` that appends its result directly to `container` (not `content` — `content` doesn't exist yet at this point in the function). Change its opening condition:

```javascript
    if (group.albumArt) {
```

to:

```javascript
    if (group.albumArt && !isIdleControlCard) {
```

and change the closing `}` of the `else if (isTvSource) { ... }` branch (`MMM-Sonos.js:488-489`, currently just `container.appendChild(artWrapper);` followed by a single closing `}`) to add a third branch after it:

```javascript
      container.appendChild(artWrapper);
    } else if (isIdleControlCard) {
      const idleWrapper = document.createElement('div');
      idleWrapper.className = 'mmm-sonos__art mmm-sonos__idle-icon';
      if (sizeValue) {
        idleWrapper.style.width = sizeValue;
        idleWrapper.style.height = sizeValue;
      }
      idleWrapper.innerText = '🔇';
      if (iconFontSize) {
        idleWrapper.style.fontSize = iconFontSize;
      }
      container.appendChild(idleWrapper);
    }
```

(A `container.appendChild(idleWrapper)` here is deliberate, not a typo — it matches the existing `artWrapper`/TV-icon branches immediately above it, which also append to `container` rather than `content`. `isIdleControlCard` and `isTvSource` are mutually exclusive in practice: a TV-source zone is only ever included in the payload because `isTvSource` already forces `allowWhenPaused` true on the backend regardless of `enableControls`, and TV zones report `playbackState: 'playing'`, so `isIdleControlCard` — which requires `!isPlaying` — is never true for one.)

Guard the `hasTrackInfo` title/artist/album block (`MMM-Sonos.js:546-590`) to skip entirely for idle cards, replacing:

```javascript
    const hasTrackInfo = group.title || group.artist;
```

with:

```javascript
    const hasTrackInfo = !isIdleControlCard && (group.title || group.artist);
```

and add, right after that same `if (hasTrackInfo && !titleIsDuplicateTv) { ... }` block closes (`MMM-Sonos.js:589-590`, `content.appendChild(titleWrapper);` then `}`), an idle-label branch:

```javascript
    } else if (isIdleControlCard) {
      const idleLabel = document.createElement('div');
      idleLabel.className = 'mmm-sonos__idle-label';
      idleLabel.innerText = this.translate('IDLE_LABEL');
      content.appendChild(idleLabel);
    }
```

Guard the playback-source block (`MMM-Sonos.js:592-598`) so it doesn't show a stale source on an idle card:

```javascript
    if (this.config.showPlaybackSource && group.source && !isTvSource && !isIdleControlCard) {
```

Finally, add the idle CSS class to the card container. Right after `container.className = 'mmm-sonos__group';` (`MMM-Sonos.js:349`):

```javascript
    container.className = 'mmm-sonos__group';
    if (isIdleControlCard) {
      container.classList.add('mmm-sonos__group--idle');
    }
```

- [ ] **Step 3: Manual verification**

With `enableControls: true` set on the live config and the server restarted, confirm in the browser: a currently-idle speaker (e.g. one not playing anything right now) now shows a card with a 🔇 icon, the "Nothing playing" label, and its current volume — no stale track title/artist/source. Confirm a currently-playing zone's card is completely unaffected (still shows title/artist/art/progress/source as before). Confirm setting `enableControls: false` (or removing it) makes idle zones disappear again exactly as before this task.

- [ ] **Step 4: Commit**

```bash
git add MMM-Sonos.js
git commit -m "feat(sonos): render idle-zone placeholder cards when enableControls is set"
```

---

### Task 6: Frontend — control overlay (open/close, play/pause, volume)

**Files:**
- Modify: `MMM-Sonos.js` (`start`, `stop`, `socketNotificationReceived`, `_renderGroup`, new overlay methods)
- CSS: `css/MMM-Sonos.css` (new rules — written in Task 8, but referenced here so the overlay isn't invisible during manual verification of this task; it's fine for this task's manual check to briefly borrow inline styles or the Task 8 CSS ahead of time if you're implementing sequentially without gaps)

**Interfaces:**
- Consumes: `group.id`, `group.name`, `group.playbackState`, `group.volume` (existing fields); sends `SONOS_CONTROL_PLAY`/`SONOS_CONTROL_PAUSE`/`SONOS_CONTROL_SET_VOLUME` `{ zoneId, volume? }`.
- Produces: `this._activeControlZoneId`, `this._controlOverlayEl` (instance state); methods `_openControlOverlay(zoneId)`, `_closeControlOverlay()`, `_syncControlOverlay()` that Task 7 (favorites) and Task 4's click handler (added here) both call into.

- [ ] **Step 1: Add instance state**

In `start()` (`MMM-Sonos.js:70-83`), add alongside the existing state:

```javascript
    this.favorites = [];
    this._activeControlZoneId = null;
    this._controlOverlayEl = null;
    this._controlVolumeDebounceTimer = null;
```

- [ ] **Step 2: Add the click handler to `_renderGroup`**

At the end of `_renderGroup`, right before `container.appendChild(content); return container;` (`MMM-Sonos.js:624-626`):

```javascript
    if (this.config.enableControls) {
      container.classList.add('mmm-sonos__group--clickable');
      container.setAttribute('role', 'button');
      container.setAttribute('tabindex', '0');
      container.addEventListener('click', () => this._openControlOverlay(group.id));
      container.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this._openControlOverlay(group.id);
        }
      });
    }

    container.appendChild(content);
    return container;
```

- [ ] **Step 3: Add overlay open/close/find methods**

Add these new methods (e.g. directly after `_renderTimestamp`):

```javascript
  _findGroupById(zoneId) {
    return (this.groups || []).find((g) => g.id === zoneId) || null;
  },

  _openControlOverlay(zoneId) {
    if (!this.config.enableControls) {
      return;
    }
    this._activeControlZoneId = zoneId;
    this._buildControlOverlay();
  },

  _closeControlOverlay() {
    this._activeControlZoneId = null;
    if (this._controlOverlayEl) {
      this._controlOverlayEl.remove();
      this._controlOverlayEl = null;
    }
  },

  _debounceSetVolume(zoneId, volume) {
    if (this._controlVolumeDebounceTimer) {
      clearTimeout(this._controlVolumeDebounceTimer);
    }
    this._controlVolumeDebounceTimer = setTimeout(() => {
      this._controlVolumeDebounceTimer = null;
      this.sendSocketNotification('SONOS_CONTROL_SET_VOLUME', { zoneId, volume });
    }, 150);
  },

  _buildControlOverlay() {
    if (this._controlOverlayEl) {
      this._controlOverlayEl.remove();
      this._controlOverlayEl = null;
    }

    const group = this._findGroupById(this._activeControlZoneId);
    if (!group) {
      this._activeControlZoneId = null;
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'mmm-sonos__overlay-backdrop';
    backdrop.dataset.moduleId = this.identifier;
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        this._closeControlOverlay();
      }
    });

    const sheet = document.createElement('div');
    sheet.className = 'mmm-sonos__overlay-sheet';

    const header = document.createElement('div');
    header.className = 'mmm-sonos__overlay-header';
    const title = document.createElement('span');
    title.className = 'mmm-sonos__overlay-title';
    title.innerText = group.name || '';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mmm-sonos__overlay-close';
    closeBtn.innerText = '×';
    closeBtn.setAttribute('aria-label', this.translate('CLOSE'));
    closeBtn.addEventListener('click', () => this._closeControlOverlay());
    header.appendChild(title);
    header.appendChild(closeBtn);
    sheet.appendChild(header);

    const errorEl = document.createElement('div');
    errorEl.className = 'mmm-sonos__overlay-error';
    errorEl.hidden = true;
    sheet.appendChild(errorEl);

    const isPlaying = ['playing', 'transitioning', 'buffering'].includes((group.playbackState || '').toLowerCase());
    const playPauseBtn = document.createElement('button');
    playPauseBtn.type = 'button';
    playPauseBtn.className = 'mmm-sonos__overlay-playpause';
    playPauseBtn.innerText = isPlaying ? '⏸' : '▶';
    playPauseBtn.dataset.isPlaying = String(isPlaying);
    playPauseBtn.addEventListener('click', () => {
      const notification = playPauseBtn.dataset.isPlaying === 'true' ? 'SONOS_CONTROL_PAUSE' : 'SONOS_CONTROL_PLAY';
      this.sendSocketNotification(notification, { zoneId: group.id });
    });
    sheet.appendChild(playPauseBtn);

    const volumeRow = document.createElement('div');
    volumeRow.className = 'mmm-sonos__overlay-volume';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = String(this.config.controlVolumeStep || 5);
    slider.value = String(group.volume ?? 0);
    slider.className = 'mmm-sonos__overlay-volume-slider';
    const volumeLabel = document.createElement('span');
    volumeLabel.className = 'mmm-sonos__overlay-volume-label';
    volumeLabel.innerText = `${slider.value}%`;
    slider.addEventListener('input', () => {
      volumeLabel.innerText = `${slider.value}%`;
      this._debounceSetVolume(group.id, Number(slider.value));
    });
    volumeRow.appendChild(slider);
    volumeRow.appendChild(volumeLabel);
    sheet.appendChild(volumeRow);

    const favoritesList = document.createElement('div');
    favoritesList.className = 'mmm-sonos__overlay-favorites';
    sheet.appendChild(favoritesList);

    backdrop.appendChild(sheet);
    document.body.appendChild(backdrop);
    this._controlOverlayEl = backdrop;
  },

  _syncControlOverlay() {
    const group = this._findGroupById(this._activeControlZoneId);
    if (!group) {
      this._showZoneUnavailableAndClose();
      return;
    }
    if (!this._controlOverlayEl) {
      return;
    }

    const title = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-title');
    if (title) {
      title.innerText = group.name || '';
    }

    const playPauseBtn = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-playpause');
    if (playPauseBtn) {
      const isPlaying = ['playing', 'transitioning', 'buffering'].includes((group.playbackState || '').toLowerCase());
      playPauseBtn.innerText = isPlaying ? '⏸' : '▶';
      playPauseBtn.dataset.isPlaying = String(isPlaying);
    }

    const slider = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-volume-slider');
    const volumeLabel = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-volume-label');
    if (slider && document.activeElement !== slider && group.volume != null) {
      slider.value = String(group.volume);
      if (volumeLabel) {
        volumeLabel.innerText = `${group.volume}%`;
      }
    }
  },

  _showZoneUnavailableAndClose() {
    if (!this._controlOverlayEl) {
      this._activeControlZoneId = null;
      return;
    }
    const errorEl = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-error');
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.innerText = this.translate('ZONE_UNAVAILABLE');
    }
    setTimeout(() => this._closeControlOverlay(), 1500);
  },

  _handleControlResult(payload) {
    if (!this._controlOverlayEl || !payload || payload.zoneId !== this._activeControlZoneId) {
      return;
    }
    const errorEl = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-error');
    if (!errorEl) {
      return;
    }
    if (payload.success) {
      errorEl.hidden = true;
      errorEl.innerText = '';
    } else {
      errorEl.hidden = false;
      const group = this._findGroupById(this._activeControlZoneId);
      errorEl.innerText = `${this.translate('CONTROL_ERROR')}${group?.name ? ': ' + group.name : ''}`;
    }
  },
```

- [ ] **Step 4: Wire overlay sync and result handling into `socketNotificationReceived`**

In the `SONOS_DATA` case (`MMM-Sonos.js:119-155`), right after `this.error = null;`, add:

```javascript
        if (this.config.enableControls && this._activeControlZoneId) {
          this._syncControlOverlay();
        }
```

Add two new cases to the `switch` (after the existing `SONOS_CACHE_CLEARED` case):

```javascript
      case 'SONOS_CONTROL_RESULT':
        this._handleControlResult(payload);
        break;
```

(The `SONOS_FAVORITES` case is added in Task 7, alongside the favorites-rendering code that consumes it.)

- [ ] **Step 5: Clean up the overlay in `stop()`**

In `stop()` (`MMM-Sonos.js:85-102`), add at the top:

```javascript
  stop() {
    this._closeControlOverlay();
    if (this.updateTimer) {
```

- [ ] **Step 6: Manual verification**

With `enableControls: true`, the server restarted, and the browser tab refreshed: click a playing card and confirm an overlay appears with the zone name, a pause icon, and a volume slider at roughly the right value. Click pause — confirm the real speaker pauses and the icon flips to play within the next `SONOS_DATA` tick. Drag the volume slider and confirm the real speaker(s) in that group change volume together after ~150ms. Click the backdrop (outside the sheet) and confirm it closes. Click an idle card (from Task 5) and confirm the overlay opens showing a play icon instead. With the overlay open on a zone, physically power off that speaker (or otherwise make it drop out of the topology) and confirm the overlay shows the "no longer available" message for about 1.5 seconds and then closes on its own.

- [ ] **Step 7: Commit**

```bash
git add MMM-Sonos.js
git commit -m "feat(sonos): add control overlay with play/pause and volume slider"
```

---

### Task 7: Frontend — favorites in the overlay, empty state, error state

**Files:**
- Modify: `MMM-Sonos.js` (`socketNotificationReceived`, `_buildControlOverlay`, `_syncControlOverlay`, new `_renderControlOverlayFavorites`)

**Interfaces:**
- Consumes: `this.favorites` (populated from `SONOS_FAVORITES`, produced by Task 3).
- Produces: the favorites list inside the already-built overlay; sends `SONOS_CONTROL_PLAY_FAVORITE { zoneId, favoriteId }`.

- [ ] **Step 1: Handle the incoming `SONOS_FAVORITES` notification**

Add to the `switch` in `socketNotificationReceived` (alongside `SONOS_CONTROL_RESULT` from Task 6):

```javascript
      case 'SONOS_FAVORITES':
        this.favorites = payload?.favorites || [];
        if (this._activeControlZoneId) {
          this._renderControlOverlayFavorites();
        }
        break;
```

- [ ] **Step 2: Render favorites into the overlay**

Add the new method:

```javascript
  _renderControlOverlayFavorites() {
    if (!this._controlOverlayEl) {
      return;
    }
    const list = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-favorites');
    if (!list) {
      return;
    }
    list.innerHTML = '';

    const group = this._findGroupById(this._activeControlZoneId);
    const maxFavorites = this.config.maxFavorites || 12;
    const favorites = (this.favorites || []).slice(0, maxFavorites);

    if (!favorites.length) {
      const empty = document.createElement('div');
      empty.className = 'mmm-sonos__overlay-favorites-empty';
      empty.innerText = this.translate('NO_FAVORITES');
      list.appendChild(empty);
      return;
    }

    favorites.forEach((favorite) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mmm-sonos__overlay-favorite';
      const isActive = !!(group && group.title && group.title === favorite.title);
      if (isActive) {
        item.classList.add('mmm-sonos__overlay-favorite--active');
      }
      item.innerText = favorite.title;
      item.addEventListener('click', () => {
        this.sendSocketNotification('SONOS_CONTROL_PLAY_FAVORITE', {
          zoneId: this._activeControlZoneId,
          favoriteId: favorite.id
        });
      });
      list.appendChild(item);
    });
  },
```

Call it at the end of `_buildControlOverlay()` (Task 6), right after `this._controlOverlayEl = backdrop;`:

```javascript
    this._controlOverlayEl = backdrop;
    this._renderControlOverlayFavorites();
```

And at the end of `_syncControlOverlay()` (Task 6), after the volume-slider sync block:

```javascript
    this._renderControlOverlayFavorites();
  },
```

- [ ] **Step 3: Manual verification**

With `enableControls: true`, open the overlay for a zone and confirm the favorites saved in the Sonos app appear as a list of buttons. Click one and confirm the real speaker starts playing that favorite within a couple of seconds, and the corresponding button gets the active/highlighted style once the now-playing title matches. Temporarily set `hiddenSpeakers`/rename to force `this.favorites = []` (or test against a system with none saved) to confirm the empty-state message appears instead of a blank gap. Trigger a deliberate failure (e.g. call `SONOS_CONTROL_PLAY` with a fake `zoneId` from the browser console) and confirm the inline error message appears in the overlay.

- [ ] **Step 4: Commit**

```bash
git add MMM-Sonos.js
git commit -m "feat(sonos): show Sonos favorites in the control overlay"
```

---

### Task 8: CSS for idle cards, clickable affordance, and the overlay

**Files:**
- Modify: `css/MMM-Sonos.css`

**Interfaces:**
- Consumes: the class names introduced in Tasks 5-7 (`mmm-sonos__group--idle`, `mmm-sonos__idle-icon`, `mmm-sonos__idle-label`, `mmm-sonos__group--clickable`, `mmm-sonos__overlay-*`).
- Produces: visual styling only — no new JS/behavior.

- [ ] **Step 1: Add the CSS rules**

Append to `css/MMM-Sonos.css`:

```css
.mmm-sonos__group--clickable {
  cursor: pointer;
}

.mmm-sonos__group--clickable:hover,
.mmm-sonos__group--clickable:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.4);
  outline-offset: 2px;
}

.mmm-sonos__group--idle {
  opacity: 0.6;
}

.mmm-sonos__idle-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
}

.mmm-sonos__idle-label {
  font-size: 0.85em;
  opacity: 0.7;
}

.mmm-sonos__overlay-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 10000;
}

.mmm-sonos__overlay-sheet {
  width: min(480px, 92vw);
  margin-bottom: 3vh;
  background: rgba(20, 20, 20, 0.96);
  border-radius: 16px 16px 8px 8px;
  padding: 1.25rem;
  color: #fff;
  font-size: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.5);
}

.mmm-sonos__overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mmm-sonos__overlay-title {
  font-size: 1.1em;
  font-weight: 600;
}

.mmm-sonos__overlay-close {
  background: none;
  border: none;
  color: #fff;
  font-size: 1.4em;
  line-height: 1;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
}

.mmm-sonos__overlay-error {
  background: rgba(200, 50, 50, 0.35);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  font-size: 0.9em;
}

.mmm-sonos__overlay-playpause {
  align-self: center;
  background: rgba(255, 255, 255, 0.12);
  border: none;
  color: #fff;
  font-size: 1.8em;
  line-height: 1;
  width: 3.2em;
  height: 3.2em;
  border-radius: 50%;
  cursor: pointer;
}

.mmm-sonos__overlay-volume {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.mmm-sonos__overlay-volume-slider {
  flex: 1;
}

.mmm-sonos__overlay-volume-label {
  min-width: 3.5em;
  text-align: right;
  opacity: 0.85;
}

.mmm-sonos__overlay-favorites {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 40vh;
  overflow-y: auto;
}

.mmm-sonos__overlay-favorite {
  text-align: left;
  background: rgba(255, 255, 255, 0.06);
  border: none;
  color: #fff;
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.95em;
}

.mmm-sonos__overlay-favorite--active {
  background: rgba(255, 255, 255, 0.22);
  font-weight: 600;
}

.mmm-sonos__overlay-favorites-empty {
  opacity: 0.6;
  font-size: 0.9em;
  padding: 0.5rem 0;
}
```

- [ ] **Step 2: Manual verification**

Reload the mirror page with `enableControls: true` and visually confirm: idle cards look visibly muted/secondary rather than identical to playing cards; hovering a clickable card shows a focus ring; the overlay appears as a dark bottom sheet with legible white text, a centered play/pause button, a full-width volume slider, and a scrollable favorites list that doesn't overflow the screen on the mirror's actual resolution (not just the small Chrome window used earlier in this session).

- [ ] **Step 3: Commit**

```bash
git add css/MMM-Sonos.css
git commit -m "style(sonos): add styling for idle cards and the control overlay"
```

---

### Task 9: Translations, README, and final end-to-end verification

**Files:**
- Modify: `translations/en.json`, `translations/nb.json`, `README.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: the `IDLE_LABEL`, `CLOSE`, `NO_FAVORITES`, `CONTROL_ERROR` translation keys used by Tasks 5-7; documentation for every new config option added across this plan.

- [ ] **Step 1: Add translation keys**

Add to `translations/en.json` (before the closing `}`):

```json
  "IDLE_LABEL": "Nothing playing",
  "CLOSE": "Close",
  "NO_FAVORITES": "No favorites found — add some in the Sonos app",
  "CONTROL_ERROR": "Could not reach speaker",
  "ZONE_UNAVAILABLE": "This speaker is no longer available"
```

Add to `translations/nb.json` (before the closing `}`):

```json
  "IDLE_LABEL": "Ingenting spilles",
  "CLOSE": "Lukk",
  "NO_FAVORITES": "Ingen favoritter funnet — legg til i Sonos-appen",
  "CONTROL_ERROR": "Fikk ikke kontakt med høyttaler",
  "ZONE_UNAVAILABLE": "Denne høyttaleren er ikke lenger tilgjengelig"
```

- [ ] **Step 2: Update `README.md`**

Insert a new subsection directly after the existing "Fullscreen mode" section and before the `## Additional features` heading:

````markdown
### Touch control mode

Setting `enableControls: true` turns MMM-Sonos from a pure display into a
tappable control surface, for use on a touch-screen (or any mirror you're
willing to touch). It only changes behavior in `row` and `grid`
`displayMode` — `mini` and `fullscreen` are unaffected.

```javascript
{
  module: 'MMM-Sonos',
  position: 'bottom_left',
  config: {
    displayMode: 'row',
    enableControls: true,
    favoritesRefreshInterval: 300000, // how often the favorites list is re-fetched (ms)
    maxFavorites: 12,                 // max favorites shown before the list scrolls
    controlVolumeStep: 5              // slider step size
  }
}
```

With `enableControls: true`:

- Every zone on the network is shown, not just ones currently playing —
  idle speakers get a simple "Nothing playing" card instead of being
  hidden (`hideWhenNothingPlaying` and `showWhenPaused` no longer apply).
- Tapping any card (playing or idle) opens a control overlay with
  play/pause, a volume slider, and a list of your Sonos favorites.
- The volume slider controls the whole group together: every speaker in
  that group is set to the same volume level, not just the coordinator.
- Favorites come directly from what you've saved in the Sonos app
  (via Sonos' own favorites list) — there is no separate config-defined
  station list to maintain.

**Touch control mode option reference:**

| Option | Default | Description |
| --- | --- | --- |
| `enableControls` | `false` | Master switch for touch control mode. |
| `favoritesRefreshInterval` | `300000` | How often (ms) the favorites list is re-fetched from Sonos. |
| `maxFavorites` | `12` | Maximum number of favorites shown in the overlay before it scrolls. |
| `controlVolumeStep` | `5` | Step size of the volume slider in the control overlay. |
````

Also add the same four rows (`enableControls`, `favoritesRefreshInterval`, `maxFavorites`, `controlVolumeStep`) to the existing `## Configuration` reference table further up the README, in the same `| Key | Default | Description |` format already used there, right after the `tvLabel` row and before the `debug` row.

- [ ] **Step 3: Full regression + manual end-to-end pass**

Run: `cd modules/MMM-Sonos && npm test`
Expected: all tests PASS.

Run: `cd modules/MMM-Sonos && npm run lint`
Expected: no errors.

With the live server (already set up earlier in this session) and `enableControls: false` (the mirror's actual deployed setting): confirm the module looks and behaves exactly as it did before this plan started — idle speakers stay hidden, no cards are clickable, no overlay ever appears.

Then with `enableControls: true`: walk through the full flow once more end-to-end — idle and playing speakers all visible, tap a playing one, pause it, change its volume, tap an idle one, start a favorite on it, confirm errors surface correctly for an unreachable/fake zone, confirm the overlay auto-closes if you power off a speaker while its overlay is open.

Restore the mirror's config block to `enableControls: false` (or whatever the user wants deployed) once verification is complete, and restart the server one more time so the live mirror is left in its intended end-state.

- [ ] **Step 4: Commit**

```bash
git add translations/en.json translations/nb.json README.md
git commit -m "docs(sonos): document touch control mode configuration"
```
