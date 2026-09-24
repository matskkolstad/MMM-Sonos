'use strict';

/**
 * Shared end-to-end harness: starts the Sonos simulator, a real MagicMirror²
 * server with the given MMM-Sonos instances, and headless Chromium.
 *
 * Environment:
 *   CHROMIUM_PATH   path to a Chromium/Chrome binary (auto-detected if unset)
 *   MM_VERSION      MagicMirror² tag to test against (see setup.js)
 *   E2E_PORT        port for the MagicMirror server (default 8090)
 */

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

function writeMagicMirrorConfig(instances, common, language) {
  const config = {
    address: '127.0.0.1',
    port: PORT,
    ipWhitelist: [],
    language,
    locale: language === 'en' ? 'en-US' : language,
    timeFormat: 24,
    units: 'metric',
    modules: instances.map((instance) => ({
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

// Reads what an instance currently shows, keyed by group id prefix (coordinator uuid).
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
        accented: card.classList.contains('mmm-sonos__group--accented'),
        idle: card.classList.contains('mmm-sonos__group--idle')
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

/**
 * @param {object} options
 * @param {string} options.scenario   scenario name in test/e2e/scenarios
 * @param {Array}  options.instances  [{ name, position, config }]
 * @param {object} options.common     config shared by all instances
 * @param {string} [options.language]  MagicMirror language (default 'en')
 * @param {object} [options.viewport]
 */
async function startMirror({ scenario, instances, common, language = 'en', viewport = { width: 1920, height: 2000 } }) {
  setup();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });

  const sim = await startFakeSonos(loadScenario(scenario));

  const configFile = writeMagicMirrorConfig(instances, common, language);
  let log = '';
  const mm = spawn(process.execPath, ['serveronly'], {
    cwd: MM_DIR,
    env: { ...process.env, MM_CONFIG_FILE: configFile, MM_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  mm.stdout.on('data', (chunk) => { log += chunk; });
  mm.stderr.on('data', (chunk) => { log += chunk; });
  await waitForServer(BASE_URL, 30000);

  const { chromium } = require(path.join(WORKSPACE, 'node_modules', 'playwright-core'));
  const browser = await chromium.launch({ executablePath: findChromium() });
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(BASE_URL);

  const mirror = {
    sim,
    page,
    pageErrors,

    // Screenshots of each instance plus the whole page, as <label>-<instance>.png.
    async screenshot(label) {
      for (const instance of instances) {
        const el = await page.$(`.e2e-${instance.name}`);
        if (el && (await el.boundingBox())) {
          await el.screenshot({ path: path.join(OUTPUT_DIR, `${label}-${instance.name}.png`) });
        }
      }
      await page.screenshot({ path: path.join(OUTPUT_DIR, `${label}-page.png`), fullPage: true });
    },

    // Poll every instance until predicate(state) is true; state is keyed by instance name.
    async waitForRender(predicate, description, timeoutMs = 30000) {
      const started = Date.now();
      let last;
      while (Date.now() - started < timeoutMs) {
        last = {};
        for (const instance of instances) {
          last[instance.name] = await readInstance(page, instance.name);
        }
        if (predicate(last)) {
          return last;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Timed out waiting for ${description}. Last state:\n${JSON.stringify(last, null, 2)}`);
    },

    async stop(logName = 'magicmirror.log') {
      await browser.close();
      mm.kill();
      await sim.close();
      fs.writeFileSync(path.join(OUTPUT_DIR, logName), log);
    }
  };
  return mirror;
}

module.exports = { startMirror, readInstance, cardFor, loadScenario, OUTPUT_DIR };
