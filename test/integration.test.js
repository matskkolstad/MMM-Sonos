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

  // Data as reported by a real Sonos system (maintainer's debug log, 2026-09-24).
  describe('real-radio scenario (NRK Radio and myTuner)', () => {
    let groups;

    before(async () => {
      sim.setScenario(loadScenario('real-radio'));
      groups = await fetchGroups();
    });

    it('shows NRK P3 (NRK Radio service, x-sonosapi-hls, sid=277) by station name', () => {
      const bad = byName(groups, 'Bad');
      assert.equal(bad.source, 'radio');
      assert.equal(bad.title, 'NRK P3');
      assert.equal(bad.artist, null);
    });

    it('shows P4 via myTuner with station name and now-playing text', () => {
      const kitchen = byName(groups, 'Kjøkken');
      assert.equal(kitchen.source, 'radio');
      assert.equal(kitchen.title, 'P4 Lyden av Norge');
      assert.equal(kitchen.artist, 'ABBA - Dancing Queen');
    });

    it('never shows the end of the stream URL ("P04_MM?args=…") as title', () => {
      const stue = byName(groups, 'Stue');
      assert.equal(stue.source, 'radio');
      assert.equal(stue.title, 'Radio');
    });
  });

  describe('load on the speakers', () => {
    const countBy = (requests) => requests.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {});

    async function connectedHelper() {
      sim.setScenario(loadScenario('mixed-sources'));
      const helper = loadNodeHelper({ ...baseConfig, updateInterval: 5000 });
      helper.coordinator = await helper._discoverViaKnownDevices();
      sim.requests = [];
      return helper;
    }

    it('asks each playing group for its position only once per refresh (radio: twice)', async () => {
      const helper = await connectedHelper();
      await helper._refresh();
      // 5 zones (1 idle) → currentTrack() for each, plus the radio group's own metadata read.
      assert.equal(countBy(sim.requests).GetPositionInfo, 6);
    });

    it('runs one refresh for requests that arrive while a refresh is running', async () => {
      const helper = await connectedHelper();
      await Promise.all([helper._refresh(), helper._refresh(), helper._refresh(), helper._refresh()]);
      assert.equal(countBy(sim.requests).GetZoneGroupState, 1);
    });

    it('answers SONOS_REQUEST from recent data without polling the speakers again', async () => {
      const helper = await connectedHelper();
      await helper._refresh();
      const soapCalls = sim.requests.length;
      const sent = helper.notifications.length;

      for (let i = 0; i < 4; i++) {
        helper.socketNotificationReceived('SONOS_REQUEST');
      }
      await helper._refreshPromise;

      assert.equal(sim.requests.length, soapCalls, 'no extra SOAP calls');
      const replies = helper.notifications.slice(sent);
      assert.equal(replies.length, 4);
      assert.deepEqual(replies[0].payload.groups, helper.lastPayload);
      assert.equal(replies[0].payload.timestamp, helper.lastPayloadAt, 'original timestamp keeps progress correct');
    });

    it('polls again on SONOS_REQUEST once the data is older than updateInterval', async () => {
      const helper = await connectedHelper();
      await helper._refresh();
      helper.lastPayloadAt -= 6000;
      sim.requests = [];

      helper.socketNotificationReceived('SONOS_REQUEST');
      await helper._refreshPromise;

      assert.equal(countBy(sim.requests).GetZoneGroupState, 1);
    });
  });

  describe('speaker errors', () => {
    it('polls again on the next request after a failed refresh instead of replaying old data', async () => {
      sim.setScenario(loadScenario('mixed-sources'));
      const helper = loadNodeHelper({ ...baseConfig, updateInterval: 5000 });
      helper.coordinator = await helper._discoverViaKnownDevices();
      await helper._refresh();

      helper.coordinator = { getAllGroups: async () => { throw new Error('speaker offline'); } };
      await helper._refresh();
      assert.equal(helper.notifications.at(-1).notification, 'SONOS_ERROR');

      helper.coordinator = await helper._discoverViaKnownDevices();
      sim.requests = [];
      helper.socketNotificationReceived('SONOS_REQUEST');
      await helper._refreshPromise;
      assert.ok(sim.requests.some((r) => r.action === 'GetZoneGroupState'), 'the request polled the speakers');
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
