'use strict';

/**
 * End-to-end test for touch control mode (enableControls): taps cards and
 * buttons in a real MagicMirror² and checks that the simulated speakers
 * actually change. Screenshots are written to test/e2e/output/controls-*.png.
 *
 * Run with:  npm run test:e2e
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { startMirror, cardFor, OUTPUT_DIR } = require('./harness');

const UUID = {
  kitchen: 'RINCON_SIM000000000001400',
  livingRoom: 'RINCON_SIM000000000001401',
  hallway: 'RINCON_SIM000000000001402',
  bedroom: 'RINCON_SIM000000000001403',
  office: 'RINCON_SIM000000000001404'
};

const common = {
  knownDevices: ['127.0.0.1'],
  discoveryTimeout: 0,
  updateInterval: 5000,
  transitionAnimation: 'none',
  cacheAlbumArt: true,
  enableControls: true,
  showAlbum: true
};

const INSTANCES = [
  { name: 'touch', position: 'top_bar', config: { displayMode: 'row' } },
  { name: 'compact', position: 'bottom_bar', config: { displayMode: 'row', controlShowIdleZones: false } }
];

describe('Touch control mode end-to-end', { timeout: 180000 }, () => {
  let mirror;
  let page;
  let sim;

  const groupOf = (uuid) => sim.scenario.groups.find((g) => (g.members?.length ? g.members : [g.coordinator]).includes(uuid));
  const waitFor = async (predicate, description, timeoutMs = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${description}`);
  };
  const overlay = '.mmm-sonos__overlay-backdrop';
  const shot = (name) => page.screenshot({ path: path.join(OUTPUT_DIR, `controls-${name}.png`) });
  const openOverlayFor = async (uuid) => {
    await page.click(`.e2e-touch [data-group-id^="${uuid}:"]`);
    await page.waitForSelector(`${overlay} .mmm-sonos__overlay-favorite`);
  };
  const closeOverlays = async () => {
    while (await page.$(overlay)) {
      await page.click(`${overlay} >> nth=-1 >> .mmm-sonos__overlay-close`);
    }
  };

  before(async () => {
    // Norwegian UI: matches the maintainer's mirror and catches untranslated keys.
    mirror = await startMirror({ scenario: 'controls', instances: INSTANCES, common, language: 'nb', viewport: { width: 1280, height: 900 } });
    ({ page, sim } = mirror);
    await mirror.waitForRender((s) => s.touch?.cards.length === 4, 'the touch instance to show all speakers');
    await page.waitForFunction(() => [...document.querySelectorAll('.mmm-sonos img')].every((img) => img.complete));
    await mirror.screenshot('controls-cards');
  });

  after(async () => {
    await mirror?.stop('magicmirror-controls.log');
  });

  it('shows playing zones as cards and idle speakers as idle cards', async () => {
    const state = await mirror.waitForRender(() => true, 'state');
    assert.equal(cardFor(state.touch, UUID.kitchen).title, 'Mr. Brightside');
    assert.equal(cardFor(state.touch, UUID.bedroom).idle, true);
    assert.equal(cardFor(state.touch, UUID.office).idle, true);
  });

  it('collects idle speakers behind a "+" button when controlShowIdleZones is off', async () => {
    const state = await mirror.waitForRender(() => true, 'state');
    assert.equal(state.compact.cards.length, 2);
    assert.equal((await page.textContent('.e2e-compact .mmm-sonos__more-speakers-btn')).trim(), '+2');
    await page.click('.e2e-compact .mmm-sonos__more-speakers-btn');
    await page.waitForSelector(`${overlay} .mmm-sonos__more-speakers-item`);
    const names = await page.$$eval(`${overlay} .mmm-sonos__more-speakers-item`, (items) => items.map((i) => i.innerText.trim()));
    assert.deepEqual(names, ['Bedroom', 'Office']);
    await shot('more-speakers');
    await closeOverlays();
  });

  it('opens the control overlay with play/pause, volume and favorites', async () => {
    await openOverlayFor(UUID.kitchen);
    const favorites = await page.$$eval(`${overlay} .mmm-sonos__overlay-favorite`, (items) => items.map((i) => i.innerText.trim()));
    assert.deepEqual(favorites, ['NRK P3', 'P4 Lyden av Norge', 'Radio Norge', "Today's Top Hits"]);
    assert.equal(await page.inputValue(`${overlay} .mmm-sonos__overlay-volume-slider`), '25');
    await shot('overlay');
  });

  it('pauses and resumes the speaker', async () => {
    await page.click(`${overlay} .mmm-sonos__overlay-playpause`);
    await waitFor(() => groupOf(UUID.kitchen).state === 'paused', 'Kitchen to pause');
    await page.click(`${overlay} .mmm-sonos__overlay-playpause`);
    await waitFor(() => groupOf(UUID.kitchen).state === 'playing', 'Kitchen to play again');
  });

  it('changes the volume with the slider', async () => {
    await page.$eval(`${overlay} .mmm-sonos__overlay-volume-slider`, (slider) => {
      slider.value = '40';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitFor(() => sim.volumes.get(UUID.kitchen) === 40, 'Kitchen volume 40');
    await closeOverlays();
  });

  it('groups another speaker in and removes it again', async () => {
    await openOverlayFor(UUID.kitchen);
    await page.click(`${overlay} .mmm-sonos__overlay-speakers-btn`);
    await page.waitForSelector('.mmm-sonos__speakers-join-item');
    await shot('speakers');
    await page.click('.mmm-sonos__speakers-join-item:has-text("Bedroom")');
    await waitFor(() => groupOf(UUID.bedroom)?.coordinator === UUID.kitchen, 'Bedroom to join Kitchen');

    await page.waitForSelector('.mmm-sonos__speakers-member-row:has-text("Bedroom") .mmm-sonos__speakers-remove-btn:not([disabled])');
    await shot('speakers-grouped');
    await page.click('.mmm-sonos__speakers-member-row:has-text("Bedroom") .mmm-sonos__speakers-remove-btn');
    await waitFor(() => groupOf(UUID.bedroom) === undefined, 'Bedroom to leave the group');
    await closeOverlays();
  });

  it('plays a favorite on an idle speaker', async () => {
    await openOverlayFor(UUID.office);
    await page.click(`${overlay} .mmm-sonos__overlay-favorite:has-text("NRK P3")`);
    await waitFor(() => groupOf(UUID.office)?.state === 'playing', 'Office to play NRK P3');
    await page.waitForSelector(`${overlay} .mmm-sonos__overlay-favorite--active:has-text("NRK P3")`);
    await shot('favorite-playing');
    await closeOverlays();
    const state = await mirror.waitForRender((s) => cardFor(s.touch, UUID.office)?.title === 'NRK P3', 'Office card to show NRK P3');
    assert.equal(cardFor(state.touch, UUID.office).idle, false);
  });

  it('plays a Spotify playlist favorite (through the queue)', async () => {
    await openOverlayFor(UUID.bedroom);
    await page.click(`${overlay} .mmm-sonos__overlay-favorite:has-text("Today's Top Hits")`);
    await waitFor(() => groupOf(UUID.bedroom)?.state === 'playing', 'Bedroom to play the playlist');
    assert.equal(groupOf(UUID.bedroom).track.title, 'Die With A Smile');
    assert.equal(await page.$(`${overlay} .mmm-sonos__overlay-error:not([hidden])`), null, 'an error is shown');
    await closeOverlays();
  });

  // Reported on a real mirror: a paused card flickered on every update.
  it('leaves a paused card alone between updates (no flicker)', async () => {
    await openOverlayFor(UUID.kitchen);
    await page.click(`${overlay} .mmm-sonos__overlay-playpause`);
    await waitFor(() => groupOf(UUID.kitchen).state === 'paused', 'Kitchen to pause');
    await closeOverlays();
    const card = `.e2e-touch [data-group-id^="${UUID.kitchen}:"]`;
    await page.waitForSelector(`${card}.mmm-sonos__group--idle`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const handle = await page.$(card);
    await new Promise((resolve) => setTimeout(resolve, 11000)); // two update intervals
    assert.equal(await handle.evaluate((el) => el.isConnected), true, 'the paused card was re-rendered');
    await openOverlayFor(UUID.kitchen);
    await page.click(`${overlay} .mmm-sonos__overlay-playpause`);
    await waitFor(() => groupOf(UUID.kitchen).state === 'playing', 'Kitchen to play again');
    await closeOverlays();
  });

  it('shows no untranslated text keys', async () => {
    await openOverlayFor(UUID.kitchen);
    await page.click(`${overlay} .mmm-sonos__overlay-speakers-btn`);
    await page.waitForSelector('.mmm-sonos__speakers-join-item');
    const text = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(text, /\b[A-Z]+_[A-Z_]+\b/, 'a translation key is shown as text');
    await closeOverlays();
  });

  it('renders without page errors', () => {
    assert.deepEqual(mirror.pageErrors, []);
  });
});
