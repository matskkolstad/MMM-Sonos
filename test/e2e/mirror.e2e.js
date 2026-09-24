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
 * Environment:
 *   CHROMIUM_PATH   path to a Chromium/Chrome binary (auto-detected if unset)
 *   MM_VERSION      MagicMirror² tag to test against (see setup.js)
 *   E2E_PORT        port for the MagicMirror server (default 8090)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { setup, ROOT, WORKSPACE, MM_DIR } = require('./setup');
const { startFakeSonos, loadScenario } = require('./fake-sonos');

const OUTPUT_DIR = path.join(__dirname, 'output');
const PORT = Number(process.env.E2E_PORT || 8090);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CACHE_DIR = path.join(ROOT, 'cache', 'album-art');

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
  { name: 'grid', position: 'bottom_left', config: { displayMode: 'grid', columns: 2, showAlbum: true } },
  { name: 'mini', position: 'bottom_right', config: { displayMode: 'mini' } },
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

function writeMagicMirrorConfig() {
  const config = {
    address: '127.0.0.1',
    port: PORT,
    ipWhitelist: [],
    language: 'en',
    locale: 'en-US',
    timeFormat: 24,
    units: 'metric',
    modules: INSTANCES.map((instance) => ({
      module: 'MMM-Sonos',
      position: instance.position,
      classes: `e2e-${instance.name}`,
      config: { ...common, ...instance.config }
    }))
  };
  const file = path.join(MM_DIR, 'config', 'e2e-config.js');
  fs.writeFileSync(
    file,
    `let config = ${JSON.stringify(config, null, 2)};\nif (typeof module !== 'undefined') { module.exports = config; }\n`
  );
  return file;
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('No Chromium found. Set CHROMIUM_PATH to a Chromium or Chrome binary.');
  }
  return found;
}

function waitForServer(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http
        .get(url, (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
        })
        .on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`MagicMirror did not start within ${timeoutMs} ms`));
      } else {
        setTimeout(attempt, 250);
      }
    };
    attempt();
  });
}

// Reads what each instance currently shows, keyed by group id prefix (coordinator uuid).
async function readInstance(page, name) {
  return page.evaluate((instanceName) => {
    const root = document.querySelector(`.e2e-${instanceName} .mmm-sonos`);
    if (!root) {
      return null;
    }
    const text = (el, selector) => el.querySelector(selector)?.innerText.trim() || null;
    const cards = [...root.querySelectorAll('[data-group-id]')].map((card) => {
      const img = card.querySelector('img');
      return {
        id: card.dataset.groupId,
        title: text(card, '.mmm-sonos__title, .mmm-sonos__fullscreen-title, .mmm-sonos__mini-title'),
        artist: text(card, '.mmm-sonos__artist, .mmm-sonos__fullscreen-artist'),
        album: text(card, '.mmm-sonos__album, .mmm-sonos__fullscreen-album'),
        text: card.innerText.replace(/\s+/g, ' ').trim(),
        img: img ? { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 } : null,
        accented: card.classList.contains('mmm-sonos__group--accented')
      };
    });
    return {
      error: root.classList.contains('mmm-sonos--error') ? root.innerText : null,
      empty: text(root, '.mmm-sonos__empty'),
      cards
    };
  }, name);
}

const cardFor = (state, uuid) => state.cards.find((card) => card.id.startsWith(`${uuid}:`));

describe('MagicMirror² end-to-end', { timeout: 180000 }, () => {
  let sim;
  let mm;
  let mmLog = '';
  let browser;
  let page;
  const pageErrors = [];

  const screenshot = async (label) => {
    for (const instance of INSTANCES) {
      const el = await page.$(`.e2e-${instance.name}`);
      if (el && (await el.boundingBox())) {
        await el.screenshot({ path: path.join(OUTPUT_DIR, `${label}-${instance.name}.png`) });
      }
    }
    await page.screenshot({ path: path.join(OUTPUT_DIR, `${label}-page.png`), fullPage: true });
  };

  // Wait until every instance has rendered data from the given scenario.
  const waitForRender = async (predicate, description) => {
    const started = Date.now();
    let last;
    while (Date.now() - started < 30000) {
      last = {};
      for (const instance of INSTANCES) {
        last[instance.name] = await readInstance(page, instance.name);
      }
      if (predicate(last)) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${description}. Last state:\n${JSON.stringify(last, null, 2)}`);
  };

  before(async () => {
    setup();
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });

    sim = await startFakeSonos(loadScenario('mixed-sources'));

    const configFile = writeMagicMirrorConfig();
    mm = spawn(process.execPath, ['serveronly'], {
      cwd: MM_DIR,
      env: { ...process.env, MM_CONFIG_FILE: configFile, MM_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    mm.stdout.on('data', (chunk) => { mmLog += chunk; });
    mm.stderr.on('data', (chunk) => { mmLog += chunk; });
    await waitForServer(BASE_URL, 30000);

    const { chromium } = require(path.join(WORKSPACE, 'node_modules', 'playwright-core'));
    browser = await chromium.launch({ executablePath: findChromium() });
    page = await browser.newPage({ viewport: { width: 1920, height: 1600 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(BASE_URL);
  });

  after(async () => {
    await browser?.close();
    if (mm) {
      mm.kill();
    }
    await sim?.close();
    fs.writeFileSync(path.join(OUTPUT_DIR, 'magicmirror.log'), mmLog);
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
      state = await waitForRender(
        (s) => cardFor(s.row || { cards: [] }, UUID.kitchen)?.title === 'Espresso' || cardFor(s.row || { cards: [] }, UUID.kitchen)?.album === "Short n' Sweet",
        'the row instance to show the new Kitchen track'
      );
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

    it('renders without page errors', () => {
      assert.deepEqual(pageErrors, []);
    });
  });
});
