'use strict';

/**
 * End-to-end test: a real MagicMirror² server with MMM-Sonos, talking to the
 * Sonos simulator (test/e2e/fake-sonos.js), rendered in headless Chromium.
 *
 * Several module instances are configured side by side (row, grid, mini and
 * fullscreen) so every display mode is checked against the same speakers.
 * Screenshots of each instance are written to test/e2e/output/.
 *
 * Run with:  npm run test:e2e
 *
 * Environment variables: see harness.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startMirror, cardFor, loadScenario } = require('./harness');

// Group IDs from the simulator are "<coordinator uuid>:<n>".
const UUID = {
  kitchen: 'RINCON_SIM000000000001400',
  livingRoom: 'RINCON_SIM000000000001401',
  bedroom: 'RINCON_SIM000000000001403',
  office: 'RINCON_SIM000000000001404'
};

const common = {
  knownDevices: ['127.0.0.1'],
  discoveryTimeout: 0,
  updateInterval: 5000,
  transitionAnimation: 'none',
  cacheAlbumArt: true
};

// The fullscreen instance uses the exact configuration from issue #53.
// It is listed last on purpose: node_helper keeps the most recent config it
// receives, and albumArtColors must be enabled there for accent colours.
const INSTANCES = [
  { name: 'row', position: 'top_bar', config: { displayMode: 'row', showAlbum: true } },
  // grid and mini keep animations on, so live updates also exercise animated re-renders.
  { name: 'grid', position: 'bottom_left', config: { displayMode: 'grid', columns: 2, showAlbum: true, transitionAnimation: 'fade' } },
  { name: 'mini', position: 'bottom_right', config: { displayMode: 'mini', transitionAnimation: 'slide-up' } },
  {
    name: 'fullscreen',
    position: 'middle_center',
    config: {
      displayMode: 'fullscreen',
      showPlaybackSource: false,
      showVolume: false,
      albumArtSize: 80,
      showGroupMembers: false,
      allowedSpeakers: ['Kitchen'],
      albumArtColors: true
    }
  }
];

describe('MagicMirror² end-to-end', { timeout: 180000 }, () => {
  let mirror;
  let page;
  let sim;
  let pageErrors;
  const screenshot = (label) => mirror.screenshot(label);
  const waitForRender = (predicate, description) => mirror.waitForRender(predicate, description);

  before(async () => {
    mirror = await startMirror({ scenario: 'mixed-sources', instances: INSTANCES, common });
    ({ page, sim, pageErrors } = mirror);
  });

  after(async () => {
    await mirror?.stop();
  });

  describe('scenario: mixed sources (Spotify, Apple Music, radio, TV)', () => {
    let state;

    before(async () => {
      state = await waitForRender(
        (s) => s.row?.cards.length === 4 && s.mini?.cards.length === 4 && s.fullscreen && (s.fullscreen.cards.length > 0 || s.fullscreen.empty),
        'all instances to render the mixed-sources scenario'
      );
      // Give album art a moment to load before taking screenshots.
      await page.waitForFunction(() => [...document.querySelectorAll('.mmm-sonos img')].every((img) => img.complete));
      state = await waitForRender(() => true, 'final state');
      await screenshot('mixed-sources');
    });

    it('renders without module errors or page errors', () => {
      for (const instance of INSTANCES) {
        assert.equal(state[instance.name].error, null, `${instance.name} shows an error`);
      }
      assert.deepEqual(pageErrors, []);
    });

    it('shows a Spotify track with title, artist and album', () => {
      const card = cardFor(state.row, UUID.livingRoom);
      assert.equal(card.title, 'Mr. Brightside');
      assert.equal(card.artist, 'The Killers');
      assert.equal(card.album, 'Hot Fuss');
    });

    it('shows the track title for Apple Music, not the album (issue #53)', () => {
      const card = cardFor(state.row, UUID.kitchen);
      assert.equal(card.title, 'Blinding Lights');
      assert.equal(card.artist, 'The Weeknd');
      assert.equal(card.album, 'After Hours');
    });

    it('shows playback progress for a track with a known duration', () => {
      const card = cardFor(state.row, UUID.livingRoom);
      const match = card.text.match(/\b(\d+):(\d\d) \/ 3:42\b/);
      assert.ok(match, `no "m:ss / 3:42" progress in: ${card.text}`);
      // The simulator starts this track at 1:35 and advances it in real time, so the
      // exact value depends on how long startup took; it must lie between start and end.
      const seconds = Number(match[1]) * 60 + Number(match[2]);
      assert.ok(seconds >= 95 && seconds <= 222, `position ${match[0]} outside 1:35–3:42`);
    });

    it('shows no progress bar for radio', () => {
      assert.doesNotMatch(cardFor(state.row, UUID.bedroom).text, /\d:\d\d \/ \d/);
    });

    it('shows station name and now-playing text for radio', () => {
      const card = cardFor(state.row, UUID.bedroom);
      assert.equal(card.title, 'NRK P3');
      assert.equal(card.artist, 'Sigrid - Burning Bridges');
    });

    it('shows TV input as TV', () => {
      const card = cardFor(state.row, UUID.office);
      assert.match(card.text, /TV/);
    });

    it('hides the idle speaker', () => {
      assert.equal(state.row.cards.length, 4);
    });

    it('serves album art from the local cache and the images load', () => {
      const card = cardFor(state.row, UUID.livingRoom);
      assert.match(card.img.src, /^\/modules\/MMM-Sonos\/cache\/album-art\/[a-f0-9]{24}\.(jpg|png)$/);
      assert.equal(card.img.loaded, true);
    });

    it('grid and mini modes show the same groups', () => {
      assert.equal(state.grid.cards.length, 4);
      assert.equal(state.mini.cards.length, 4);
      // Mini mode shows "title · artist" on one line.
      assert.equal(cardFor(state.mini, UUID.kitchen).title, 'Blinding Lights · The Weeknd');
    });

    it('fullscreen with allowedSpeakers shows the allowed speaker even when it is not first', () => {
      assert.equal(state.fullscreen.cards.length, 1, `fullscreen shows: ${JSON.stringify(state.fullscreen)}`);
      const card = cardFor(state.fullscreen, UUID.kitchen);
      assert.ok(card, 'the Kitchen card is shown');
      assert.equal(card.title, 'Blinding Lights');
      assert.equal(card.artist, 'The Weeknd');
    });

    it('fullscreen applies accent colours from the album art (albumArtColors)', () => {
      assert.equal(state.fullscreen.cards[0]?.accented, true);
    });
  });

  describe('scenario: live update to other services', () => {
    let state;

    before(async () => {
      sim.setScenario(loadScenario('more-services'));
      // No reload: the module must pick up the change on its own polling interval.
      const showsNewKitchenTrack = (instance) => {
        const card = cardFor(instance || { cards: [] }, UUID.kitchen);
        return !!card && (card.title || '').startsWith('Espresso') || card?.album === "Short n' Sweet";
      };
      state = await waitForRender(
        (s) => showsNewKitchenTrack(s.row) && showsNewKitchenTrack(s.grid) && showsNewKitchenTrack(s.mini),
        'row, grid and mini to show the new Kitchen track'
      );
      // Let running animations finish before the final read.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await page.waitForFunction(() => [...document.querySelectorAll('.mmm-sonos img')].every((img) => img.complete));
      state = await waitForRender(() => true, 'final state');
      await screenshot('more-services');
    });

    it('updates to the new track without a page reload', () => {
      const card = cardFor(state.row, UUID.kitchen);
      assert.equal(card.title, 'Espresso');
      assert.equal(card.artist, 'Sabrina Carpenter');
    });

    it('shows a local music library track', () => {
      const card = cardFor(state.row, UUID.livingRoom);
      assert.equal(card.title, 'One More Time');
      assert.equal(card.artist, 'Daft Punk');
    });

    it('shows Sonos Radio as radio with the now-playing text', () => {
      const card = cardFor(state.row, UUID.bedroom);
      assert.equal(card.title, 'Sonos Radio Hits');
      assert.equal(card.artist, 'Dua Lipa - Houdini');
    });

    it('hides the paused group when showWhenPaused is false', () => {
      assert.equal(cardFor(state.row, UUID.office), undefined);
    });

    it('animated instances (grid, mini) show the same final state as the row instance', () => {
      for (const name of ['grid', 'mini']) {
        assert.deepEqual(
          state[name].cards.map((card) => card.id).sort(),
          state.row.cards.map((card) => card.id).sort(),
          `${name} shows other groups than row`
        );
        assert.equal(cardFor(state[name], UUID.office), undefined, `${name} still shows the paused group`);
      }
      assert.equal(cardFor(state.grid, UUID.kitchen).title, 'Espresso');
    });

    it('renders without page errors', () => {
      assert.deepEqual(pageErrors, []);
    });
  });
});
