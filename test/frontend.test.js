'use strict';

/**
 * Unit tests for the browser-side module (MMM-Sonos.js).
 *
 * The real MMM-Sonos.js is evaluated in a sandbox through
 * test/helpers/load-module.js; only Module.register() and translate() are
 * provided by the test harness. Methods that need a DOM are covered by the
 * end-to-end test instead.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadFrontendModule } = require('./helpers/load-module');

const makeGroup = (overrides = {}) => ({
  id: 'group-1',
  name: 'Living Room',
  playbackState: 'playing',
  title: 'Song Title',
  artist: 'Artist',
  album: 'Album',
  albumArt: 'http://example.com/art.jpg',
  source: 'spotify',
  members: ['Speaker A'],
  volume: 50,
  duration: 240,
  position: 30,
  ...overrides
});

// Call the real _analyzeChanges() with `current` as the module's previous state.
function analyze(current, next, lastUpdated, newTimestamp) {
  const mod = loadFrontendModule();
  mod.groups = current;
  mod.lastUpdated = lastUpdated;
  return mod._analyzeChanges(next, newTimestamp);
}

describe('_analyzeChanges() – playing-like state transitions', () => {
  const now = Date.now();

  it('returns needsFull: false for PLAYING → TRANSITIONING (same track)', () => {
    const result = analyze([makeGroup()], [makeGroup({ playbackState: 'transitioning' })], now - 1000, now);
    assert.equal(result.needsFull, false);
  });

  it('returns needsFull: false for TRANSITIONING → PLAYING (same track)', () => {
    const result = analyze([makeGroup({ playbackState: 'transitioning' })], [makeGroup()], now - 1000, now);
    assert.equal(result.needsFull, false);
  });

  it('returns needsFull: false for PLAYING → BUFFERING (same track)', () => {
    const result = analyze([makeGroup()], [makeGroup({ playbackState: 'buffering' })], now - 1000, now);
    assert.equal(result.needsFull, false);
  });

  it('returns needsFull: true for PLAYING → PAUSED (structural state change)', () => {
    const result = analyze([makeGroup()], [makeGroup({ playbackState: 'paused' })], now - 1000, now);
    assert.equal(result.needsFull, true);
  });

  it('returns needsFull: true for PLAYING → STOPPED (structural state change)', () => {
    const result = analyze([makeGroup()], [makeGroup({ playbackState: 'stopped' })], now - 1000, now);
    assert.equal(result.needsFull, true);
  });

  it('adds group id to changedIds when title changes during PLAYING → TRANSITIONING', () => {
    const result = analyze(
      [makeGroup({ title: 'Old Song' })],
      [makeGroup({ playbackState: 'transitioning', title: 'New Song' })],
      now - 1000,
      now
    );
    assert.equal(result.needsFull, false);
    assert.equal(result.changedIds.has('group-1'), true);
  });

  it('adds to volumeChangedIds for volume-only change (no animation needed)', () => {
    const result = analyze([makeGroup({ volume: 50 })], [makeGroup({ volume: 60 })], now - 1000, now);
    assert.equal(result.needsFull, false);
    assert.equal(result.changedIds.size, 0);
    assert.equal(result.volumeChangedIds.has('group-1'), true);
  });

  it('adds group id to changedIds on a seek (position jump > 3 s)', () => {
    const result = analyze([makeGroup({ position: 30 })], [makeGroup({ position: 120 })], now - 1000, now);
    assert.equal(result.changedIds.has('group-1'), true);
  });

  it('does not treat normal playback progress as a change', () => {
    const result = analyze([makeGroup({ position: 30 })], [makeGroup({ position: 45 })], now - 15000, now);
    assert.equal(result.needsFull, false);
    assert.equal(result.changedIds.size, 0);
  });

  it('returns needsFull: true when group members change', () => {
    const result = analyze([makeGroup()], [makeGroup({ members: ['Speaker B'] })], now - 1000, now);
    assert.equal(result.needsFull, true);
  });

  it('returns needsFull: true when group count changes (new group appears)', () => {
    const result = analyze([makeGroup()], [makeGroup(), makeGroup({ id: 'group-2', name: 'Kitchen' })], now - 1000, now);
    assert.equal(result.needsFull, true);
  });

  it('returns needsFull: true when first data arrives (empty → groups)', () => {
    const result = analyze([], [makeGroup()], null, now);
    assert.equal(result.needsFull, true);
  });

  it('returns needsFull: false when there was and is nothing playing', () => {
    const result = analyze([], [], null, now);
    assert.equal(result.needsFull, false);
  });
});

describe('_isHidden() – whitelist/blacklist filtering', () => {
  const group = {
    id: 'RINCON_ABC:1',
    name: 'Stue',
    members: ['Stue', 'Hjemmekontor'],
    coordinatorHost: '192.168.1.50'
  };
  const isHidden = (config) => loadFrontendModule(config)._isHidden(group);

  it('returns false when no filters are configured', () => {
    assert.equal(isHidden({}), false);
  });

  it('hides by group name (blacklist)', () => {
    assert.equal(isHidden({ hiddenGroups: ['stue'] }), true);
  });

  it('hides by group ID (blacklist)', () => {
    assert.equal(isHidden({ hiddenGroups: ['RINCON_ABC:1'] }), true);
  });

  it('hides by member name (blacklist)', () => {
    assert.equal(isHidden({ hiddenSpeakers: ['hjemmekontor'] }), true);
  });

  it('hides by coordinator IP (blacklist)', () => {
    assert.equal(isHidden({ hiddenSpeakers: ['192.168.1.50'] }), true);
  });

  it('does not hide an unrelated group (blacklist)', () => {
    assert.equal(isHidden({ hiddenGroups: ['Kjøkken'], hiddenSpeakers: ['Bad'] }), false);
  });

  it('shows group when it matches allowedGroups whitelist', () => {
    assert.equal(isHidden({ allowedGroups: ['Stue'] }), false);
  });

  it('hides group that does not match allowedGroups whitelist', () => {
    assert.equal(isHidden({ allowedGroups: ['Kjøkken'] }), true);
  });

  it('shows group when its coordinator IP matches allowedGroups', () => {
    assert.equal(isHidden({ allowedGroups: ['192.168.1.50'] }), false);
  });

  it('shows group when member matches allowedSpeakers whitelist', () => {
    assert.equal(isHidden({ allowedSpeakers: ['Stue'] }), false);
  });

  it('hides group when no members match allowedSpeakers whitelist', () => {
    assert.equal(isHidden({ allowedSpeakers: ['Kjøkken'] }), true);
  });

  it('shows group when coordinator IP matches allowedSpeakers whitelist', () => {
    assert.equal(isHidden({ allowedSpeakers: ['192.168.1.50'] }), false);
  });

  it('blacklist takes precedence over whitelist', () => {
    assert.equal(isHidden({ hiddenGroups: ['Stue'], allowedGroups: ['Stue'] }), true);
  });
});

describe('_resolveDisplayMode()', () => {
  const resolve = (displayMode, groupCount, columns) => {
    const mod = loadFrontendModule({ displayMode, columns });
    mod.groups = Array.from({ length: groupCount }, (_, i) => makeGroup({ id: `g${i}` }));
    return mod._resolveDisplayMode();
  };

  it('returns "fullscreen" when configured', () => {
    assert.equal(resolve('fullscreen', 3, 2), 'fullscreen');
  });

  it('returns "mini" when configured', () => {
    assert.equal(resolve('mini', 3, 2), 'mini');
  });

  it('returns "grid" when configured explicitly', () => {
    assert.equal(resolve('grid', 1, 2), 'grid');
  });

  it('returns "row" when configured explicitly', () => {
    assert.equal(resolve('row', 5, 2), 'row');
  });

  it('returns "grid" in auto mode when groupCount exceeds columns', () => {
    assert.equal(resolve('auto', 3, 2), 'grid');
  });

  it('returns "row" in auto mode when groupCount does not exceed columns', () => {
    assert.equal(resolve('auto', 2, 2), 'row');
  });

  it('falls back to "row" in auto mode for unknown/null displayMode', () => {
    assert.equal(resolve(null, 1, 2), 'row');
  });
});

describe('_resolveFullscreenGroup()', () => {
  const groups = [
    { id: 'RINCON_A:1', name: 'Stue', coordinatorHost: '192.168.1.10', members: ['Stue', 'Hall'], playbackState: 'playing' },
    { id: 'RINCON_B:1', name: 'Kjøkken', coordinatorHost: '192.168.1.20', members: ['Kjøkken'], playbackState: 'playing' },
    { id: 'RINCON_C:1', name: 'Soverom', coordinatorHost: '192.168.1.30', members: ['Soverom'], playbackState: 'playing' }
  ];
  const resolve = (fullscreenSpeaker, groupList = groups, extraConfig = {}) => {
    const mod = loadFrontendModule({ fullscreenSpeaker, ...extraConfig });
    mod.groups = groupList;
    return mod._resolveFullscreenGroup();
  };

  it('returns first group when fullscreenSpeaker is null', () => {
    assert.equal(resolve(null), groups[0]);
  });

  it('returns first group when fullscreenSpeaker is empty string', () => {
    assert.equal(resolve(''), groups[0]);
  });

  it('matches by group name (case-insensitive)', () => {
    assert.equal(resolve('kjøkken'), groups[1]);
  });

  it('matches by group ID', () => {
    assert.equal(resolve('RINCON_C:1'), groups[2]);
  });

  it('matches by coordinator IP', () => {
    assert.equal(resolve('192.168.1.20'), groups[1]);
  });

  it('matches by member name', () => {
    assert.equal(resolve('hall'), groups[0]);
  });

  it('falls back to first group when no match is found', () => {
    assert.equal(resolve('BadRoom'), groups[0]);
  });

  it('returns null when groups array is empty', () => {
    assert.equal(resolve('Stue', []), null);
  });

  it('returns null when groups is null', () => {
    assert.equal(resolve(null, null), null);
  });

  // Previously the first group was picked even when allowedSpeakers hid it, so fullscreen
  // showed "No speakers are visible" although the allowed speaker was playing.
  it('picks the first group allowed by allowedSpeakers, not the first group overall', () => {
    assert.equal(resolve(null, groups, { allowedSpeakers: ['Kjøkken'] }), groups[1]);
  });

  it('skips groups hidden by hiddenSpeakers', () => {
    assert.equal(resolve(null, groups, { hiddenSpeakers: ['Stue'] }), groups[1]);
  });

  it('skips paused groups unless showWhenPaused is enabled', () => {
    const withPaused = [{ ...groups[0], playbackState: 'paused' }, groups[1]];
    assert.equal(resolve(null, withPaused), withPaused[1]);
    assert.equal(resolve(null, withPaused, { showWhenPaused: true }), withPaused[0]);
  });

  it('does not pick a pinned speaker that allowedSpeakers hides', () => {
    assert.equal(resolve('Stue', groups, { allowedSpeakers: ['Soverom'] }), groups[2]);
  });

  it('keeps a pinned speaker even when it is paused (renders nothing instead of switching)', () => {
    const withPaused = [groups[0], { ...groups[1], playbackState: 'paused' }];
    assert.equal(resolve('Kjøkken', withPaused), withPaused[1]);
  });

  it('returns null when no group is visible', () => {
    assert.equal(resolve(null, groups, { allowedSpeakers: ['Bad'] }), null);
  });
});

describe('_isGroupVisible()', () => {
  const group = makeGroup({ name: 'Stue', members: ['Stue'] });

  it('is true for a playing group without filters', () => {
    assert.equal(loadFrontendModule()._isGroupVisible(group), true);
  });

  it('is true for transitioning and buffering groups', () => {
    const mod = loadFrontendModule();
    assert.equal(mod._isGroupVisible({ ...group, playbackState: 'transitioning' }), true);
    assert.equal(mod._isGroupVisible({ ...group, playbackState: 'buffering' }), true);
  });

  it('is false for a paused group unless showWhenPaused is enabled', () => {
    const paused = { ...group, playbackState: 'paused' };
    assert.equal(loadFrontendModule()._isGroupVisible(paused), false);
    assert.equal(loadFrontendModule({ showWhenPaused: true })._isGroupVisible(paused), true);
  });

  it('is false for a group filtered out by allowedSpeakers', () => {
    assert.equal(loadFrontendModule({ allowedSpeakers: ['Kjøkken'] })._isGroupVisible(group), false);
  });
});

describe('_formatTime()', () => {
  const mod = loadFrontendModule();

  it('formats seconds as m:ss', () => {
    assert.equal(mod._formatTime(65), '1:05');
  });

  it('formats hours as h:mm:ss', () => {
    assert.equal(mod._formatTime(3725), '1:02:05');
  });
});
