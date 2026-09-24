'use strict';

/**
 * Integration tests: the real node_helper.js and the real `sonos` package
 * talking over HTTP to the Sonos simulator (test/e2e/fake-sonos.js).
 * No MagicMirror² or browser needed, so these run as part of `npm test`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { loadNodeHelper } = require('./helpers/load-module');
const { startFakeSonos, loadScenario } = require('./e2e/fake-sonos');

const baseConfig = {
  knownDevices: ['127.0.0.1'],
  discoveryTimeout: 0,
  cacheAlbumArt: false,
  hideWhenNothingPlaying: true,
  showWhenPaused: false,
  maxGroups: 6
};

async function fetchGroups(config = {}) {
  const helper = loadNodeHelper({ ...baseConfig, ...config });
  helper.coordinator = await helper._discoverViaKnownDevices();
  await helper._refresh();
  const data = helper.notifications.find((n) => n.notification === 'SONOS_DATA');
  assert.ok(data, `expected SONOS_DATA, got ${JSON.stringify(helper.notifications)}`);
  return data.payload.groups;
}

const byName = (groups, name) => groups.find((g) => g.name === name);

describe('node_helper against the Sonos simulator', () => {
  let sim;

  before(async () => {
    sim = await startFakeSonos(loadScenario('mixed-sources'));
  });

  after(async () => {
    await sim.close();
  });

  describe('mixed-sources scenario', () => {
    let groups;

    before(async () => {
      sim.setScenario(loadScenario('mixed-sources'));
      groups = await fetchGroups();
    });

    it('returns the playing groups sorted by name and skips the idle speaker', () => {
      assert.deepEqual(groups.map((g) => g.name), ['Bedroom', 'Kitchen', 'Living Room + 1', 'Office']);
    });

    it('reports an Apple Music track with its real title (issue #53)', () => {
      const kitchen = byName(groups, 'Kitchen');
      assert.equal(kitchen.source, 'apple_music');
      assert.equal(kitchen.title, 'Blinding Lights');
      assert.equal(kitchen.artist, 'The Weeknd');
      assert.equal(kitchen.album, 'After Hours');
      assert.equal(kitchen.duration, 200);
      assert.equal(kitchen.volume, 25);
    });

    it('reports Spotify with group members', () => {
      const living = byName(groups, 'Living Room + 1');
      assert.equal(living.source, 'spotify');
      assert.equal(living.title, 'Mr. Brightside');
      assert.deepEqual(living.members, ['Living Room', 'Hallway']);
    });

    it('reports radio with station name as title and stream text as artist', () => {
      const bedroom = byName(groups, 'Bedroom');
      assert.equal(bedroom.source, 'radio');
      assert.equal(bedroom.title, 'NRK P3');
      assert.equal(bedroom.artist, 'Sigrid - Burning Bridges');
      assert.equal(bedroom.albumArt, 'http://127.0.0.1:1403/art/green.png');
    });

    it('reports the TV input', () => {
      const office = byName(groups, 'Office');
      assert.equal(office.source, 'tv');
      assert.equal(office.isTvSource, true);
    });
  });

  describe('more-services scenario', () => {
    let groups;

    before(async () => {
      sim.setScenario(loadScenario('more-services'));
      groups = await fetchGroups();
    });

    it('reports an Amazon Music track with its real title, not as radio', () => {
      const kitchen = byName(groups, 'Kitchen');
      assert.notEqual(kitchen.source, 'radio');
      assert.equal(kitchen.title, 'Espresso');
      assert.equal(kitchen.artist, 'Sabrina Carpenter');
    });

    it('reports a local library track', () => {
      const living = byName(groups, 'Living Room');
      assert.equal(living.title, 'One More Time');
      assert.equal(living.album, 'Discovery');
    });

    it('reports Sonos Radio as radio', () => {
      const bedroom = byName(groups, 'Bedroom');
      assert.equal(bedroom.source, 'radio');
      assert.equal(bedroom.title, 'Sonos Radio Hits');
      assert.equal(bedroom.artist, 'Dua Lipa - Houdini');
    });

    it('leaves out paused groups unless showWhenPaused is enabled', async () => {
      assert.equal(byName(groups, 'Office'), undefined);
      const withPaused = await fetchGroups({ showWhenPaused: true });
      assert.equal(byName(withPaused, 'Office').playbackState, 'paused');
    });
  });

  describe('maxGroups', () => {
    it('is not applied by node_helper (each frontend instance applies it after its own filters)', async () => {
      sim.setScenario(loadScenario('mixed-sources'));
      const groups = await fetchGroups({ maxGroups: 1 });
      assert.equal(groups.length, 4);
    });
  });
});
