'use strict';

/**
 * Integration tests: the real node_helper.js and the real `sonos` package
 * talking over HTTP to the Sonos simulator (test/e2e/fake-sonos.js).
 * No MagicMirror² or browser needed, so these run as part of `npm test`.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
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

    it('lists the favorites that can be played and skips Sonos Radio entries without an address', async () => {
      const helper = loadNodeHelper({ ...baseConfig, enableControls: true });
      await helper._refresh();
      await helper._favoritesPromise;
      assert.deepEqual(helper.favorites.map((f) => f.title), ['NRK P3', 'P4 Lyden av Norge', 'Your Top Songs 2021']);
    });

    it('plays each of the real favorites: two radio streams and a Spotify playlist', async () => {
      const helper = loadNodeHelper({ ...baseConfig, enableControls: true });
      await helper._refresh();
      await helper._favoritesPromise;
      const stue = () => helper.lastPayload.find((g) => g.members.includes('Stue'));
      for (const [title, expected] of [['NRK P3', 'NRK P3'], ['P4 Lyden av Norge', 'P4 Lyden av Norge'], ['Your Top Songs 2021', 'Levitating']]) {
        const favorite = helper.favorites.find((f) => f.title === title);
        await helper._handlePlayFavorite(stue().id, favorite.id);
        const result = helper.notifications.filter((n) => n.notification === 'SONOS_CONTROL_RESULT').at(-1).payload;
        assert.equal(result.success, true, `${title}: ${result.error}`);
        await helper._refresh();
        assert.equal(stue().title, expected);
      }
    });

    it('never shows the end of the stream URL ("P04_MM?args=…") as title', () => {
      const stue = byName(groups, 'Stue');
      assert.equal(stue.source, 'radio');
      assert.equal(stue.title, 'Radio');
    });
  });

  describe('stream status texts', () => {
    it('never shows Sonos status placeholders such as ZPSTR_CONNECTING (reported on a real system)', async () => {
      const scenario = loadScenario('real-radio');
      scenario.groups[1].track.streamContent = 'ZPSTR_CONNECTING';
      sim.setScenario(scenario);
      const groups = await fetchGroups();
      const kitchen = byName(groups, 'Kjøkken');
      assert.equal(kitchen.title, 'P4 Lyden av Norge');
      assert.equal(kitchen.artist, null);
      assert.equal(kitchen.streamTitle, null);
    });

    it('also hides ZPSTR_BUFFERING for a stream without a station name', async () => {
      const scenario = loadScenario('real-radio');
      scenario.groups[2].track.title = 'ZPSTR_BUFFERING';
      sim.setScenario(scenario);
      const groups = await fetchGroups();
      assert.equal(byName(groups, 'Stue').title, 'Radio');
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

  describe('touch control mode (enableControls) against the simulator', () => {
    let helper;
    const zone = (name) => helper.lastPayload.find((g) => g.members.includes(name));
    const settle = async () => {
      // Control handlers queue a refresh; wait for it (and any it was queued behind).
      await new Promise((resolve) => setTimeout(resolve, 20));
      while (helper._refreshPromise) {
        await helper._refreshPromise;
      }
    };
    const lastResult = () => helper.notifications.filter((n) => n.notification === 'SONOS_CONTROL_RESULT').at(-1).payload;

    beforeEach(async () => {
      sim.setScenario(loadScenario('controls'));
      helper = loadNodeHelper({ ...baseConfig, enableControls: true });
      helper.coordinator = await helper._discoverViaKnownDevices();
      await helper._refresh();
    });

    it('includes idle speakers so they can be started', () => {
      assert.equal(zone('Bedroom').playbackState, 'stopped');
      assert.equal(zone('Office').playbackState, 'stopped');
    });

    it('reports per-speaker volume for grouped zones', () => {
      assert.deepEqual(zone('Hallway').memberDetails.map((m) => [m.name, m.volume]), [['Living Room', 30], ['Hallway', 30]]);
    });

    it('pauses and resumes a zone, and the change is visible right away', async () => {
      await helper._handlePause(zone('Kitchen').id);
      await settle();
      assert.equal(lastResult().success, true);
      assert.equal(zone('Kitchen').playbackState, 'paused');

      await helper._handlePlay(zone('Kitchen').id);
      await settle();
      assert.equal(zone('Kitchen').playbackState, 'playing');
    });

    it('sets the volume of every speaker in a group', async () => {
      await helper._handleSetVolume(zone('Hallway').id, 12);
      await helper._refresh(); // volume changes are not followed by a refresh (sliders send many)
      assert.deepEqual(zone('Hallway').memberDetails.map((m) => m.volume), [12, 12]);
    });

    it('sets the volume of a single speaker in a group', async () => {
      await helper._handleSetMemberVolume(zone('Hallway').id, 'Hallway', 45);
      await helper._refresh();
      assert.deepEqual(zone('Hallway').memberDetails.map((m) => [m.name, m.volume]), [['Living Room', 30], ['Hallway', 45]]);
    });

    it('joins another speaker into a group and removes it again', async () => {
      await helper._handleJoinGroup(zone('Kitchen').id, zone('Bedroom').id);
      await settle();
      assert.equal(lastResult().success, true);
      assert.deepEqual(zone('Kitchen').members, ['Kitchen', 'Bedroom']);

      await helper._handleLeaveGroup(zone('Kitchen').id, 'Bedroom');
      await settle();
      assert.deepEqual(zone('Kitchen').members, ['Kitchen']);
      assert.deepEqual(zone('Bedroom').members, ['Bedroom']);
    });

    it('loads the Sonos favorites', async () => {
      await helper._refreshFavorites();
      assert.deepEqual(helper.favorites.map((f) => f.title), ['NRK P3', 'P4 Lyden av Norge', 'Radio Norge', "Today's Top Hits"]);
      assert.equal(helper.notifications.at(-1).notification, 'SONOS_FAVORITES');
    });

    it('plays a favorite on an idle speaker', async () => {
      await helper._refreshFavorites();
      const nrk = helper.favorites.find((f) => f.title === 'NRK P3');
      await helper._handlePlayFavorite(zone('Office').id, nrk.id);
      await settle();
      assert.equal(lastResult().success, true);
      assert.equal(zone('Office').playbackState, 'playing');
      assert.equal(zone('Office').title, 'NRK P3');
      assert.equal(zone('Office').source, 'radio');
    });

    it('plays a Spotify playlist favorite through the queue (reported on a real system)', async () => {
      await helper._refreshFavorites();
      const playlist = helper.favorites.find((f) => f.title === "Today's Top Hits");
      await helper._handlePlayFavorite(zone('Office').id, playlist.id);
      await settle();
      assert.equal(lastResult().success, true, `favorite failed: ${lastResult().error}`);
      assert.equal(zone('Office').playbackState, 'playing');
      assert.equal(zone('Office').title, 'Die With A Smile');
      assert.equal(zone('Office').source, 'spotify');
    });

    it('replaces the queue when a playlist favorite is played again', async () => {
      await helper._refreshFavorites();
      const playlist = helper.favorites.find((f) => f.title === "Today's Top Hits");
      await helper._handlePlayFavorite(zone('Office').id, playlist.id);
      await settle();
      await helper._handlePlayFavorite(zone('Office').id, playlist.id);
      await settle();
      assert.equal(sim.queues.get('RINCON_SIM000000000001404').length, 2);
    });

    it('sends the favorite metadata along, so the station name is known', async () => {
      await helper._refreshFavorites();
      const p4 = helper.favorites.find((f) => f.title === 'P4 Lyden av Norge');
      await helper._handlePlayFavorite(zone('Bedroom').id, p4.id);
      await settle();
      assert.equal(zone('Bedroom').title, 'P4 Lyden av Norge');
    });

    // Reported on a real system: favorites only appeared minutes after startup when the
    // speakers had not been found yet at startup.
    it('loads favorites as soon as the speakers are found, not minutes later', async () => {
      const fresh = loadNodeHelper({ ...baseConfig, enableControls: true });
      await fresh._refreshFavorites(); // at startup: no speaker known yet
      assert.equal(fresh._favoritesLoaded, undefined);

      await fresh._refresh(); // finds the speakers via knownDevices
      await fresh._favoritesPromise;
      assert.equal(fresh.favorites.length, 4);
      assert.ok(fresh.notifications.some((n) => n.notification === 'SONOS_FAVORITES'));
    });

    it('sends the loaded favorites to a browser that connects later', async () => {
      await helper._refreshFavorites();
      helper.notifications = [];
      helper._configure = async () => {}; // only the notification matters here
      helper.socketNotificationReceived('SONOS_CONFIG', { instanceId: 'late-browser', enableControls: true });
      assert.equal(helper.notifications.at(-1).notification, 'SONOS_FAVORITES');
    });

    it('names the step and the favorite when Sonos rejects a favorite', async () => {
      await helper._refreshFavorites();
      const playlist = helper.favorites.find((f) => f.title === "Today's Top Hits");
      helper._isContainerFavorite = () => false; // force the stream path, which Sonos rejects for playlists
      await helper._handlePlayFavorite(zone('Office').id, playlist.id);
      assert.match(lastResult().error, /^play stream: UPnP error 714 \(favorite "Today's Top Hits", object\.container\.playlistContainer, x-rincon-cpcontainer:/);
    });

    // Reported on a real system: the group ID came from the speaker that created the
    // group, so the queue of the wrong speaker was selected (UPnP 714 at "select queue").
    it('plays a playlist on a group whose ID comes from another speaker', async () => {
      const scenario = loadScenario('controls');
      scenario.groups[1].groupIdFrom = 'RINCON_SIM000000000001402'; // Living Room group created by Hallway
      sim.setScenario(scenario);
      await helper._refresh();
      assert.match(zone('Living Room').id, /^RINCON_SIM000000000001402:/);
      await helper._refreshFavorites();
      const playlist = helper.favorites.find((f) => f.title === "Today's Top Hits");
      await helper._handlePlayFavorite(zone('Living Room').id, playlist.id);
      await settle();
      assert.equal(lastResult().success, true, `favorite failed: ${lastResult().error}`);
      assert.equal(zone('Living Room').title, 'Die With A Smile');
    });

    // Reported on a real system: the first speaker found could not list favorites.
    it('loads favorites from another speaker when the first one cannot list them', async () => {
      sim.scenario.speakers.find((sp) => sp.port === 1400).noFavorites = true;
      const fresh = loadNodeHelper({ ...baseConfig, enableControls: true });
      await fresh._refresh();
      await fresh._favoritesPromise;
      assert.equal(fresh.favorites.length, 4);
    });

    it('does not retry a failing favorites fetch on every refresh', async () => {
      for (const sp of sim.scenario.speakers) {
        sp.noFavorites = true;
      }
      const fresh = loadNodeHelper({ ...baseConfig, enableControls: true });
      await fresh._refresh();
      await fresh._favoritesPromise;
      sim.requests = [];
      fresh.lastPayloadAt = null;
      await fresh._refresh();
      await fresh._favoritesPromise;
      assert.equal(sim.requests.filter((r) => r.action === 'Browse').length, 0);
    });

    it('reports an error for an unknown zone without contacting any speaker', async () => {
      sim.requests = [];
      await helper._handlePlay('no-such-zone');
      assert.deepEqual(lastResult(), { zoneId: 'no-such-zone', action: 'play', success: false, error: 'Zone not found' });
      assert.equal(sim.requests.length, 0);
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
