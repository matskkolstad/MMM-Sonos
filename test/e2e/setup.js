'use strict';

/**
 * Prepares the end-to-end test workspace in .e2e/ (git-ignored):
 *
 *   .e2e/MagicMirror          a real MagicMirror² checkout (server-only install)
 *   .e2e/MagicMirror/modules/MMM-Sonos -> symlink to this repository
 *   .e2e/node_modules/playwright-core  browser automation (kept out of the
 *                                      module's own dependencies on purpose)
 *
 * Re-running is cheap: steps that are already done are skipped.
 *
 * Environment:
 *   MM_VERSION   MagicMirror² git tag to test against (default below)
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE = path.join(ROOT, '.e2e');
const MM_DIR = path.join(WORKSPACE, 'MagicMirror');
const MM_VERSION = process.env.MM_VERSION || 'v2.37.0';
const PLAYWRIGHT_VERSION = '1.63.0';

function run(command, args, cwd) {
  console.log(`[e2e setup] ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function installedMagicMirrorVersion() {
  try {
    return `v${JSON.parse(fs.readFileSync(path.join(MM_DIR, 'package.json'), 'utf8')).version}`;
  } catch {
    return null;
  }
}

function setupMagicMirror() {
  if (installedMagicMirrorVersion() !== MM_VERSION) {
    fs.rmSync(MM_DIR, { recursive: true, force: true });
    run('git', ['clone', '--quiet', '--depth', '1', '--branch', MM_VERSION,
      'https://github.com/MagicMirrorOrg/MagicMirror.git', MM_DIR], WORKSPACE);
  }
  if (!fs.existsSync(path.join(MM_DIR, 'node_modules', 'express'))) {
    run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', '--omit=optional'], MM_DIR);
  }

  const link = path.join(MM_DIR, 'modules', 'MMM-Sonos');
  if (!fs.existsSync(link)) {
    fs.symlinkSync(ROOT, link, 'dir');
  }
}

function setupPlaywright() {
  const pkgPath = path.join(WORKSPACE, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'mmm-sonos-e2e', private: true }, null, 2));
  }
  const installed = path.join(WORKSPACE, 'node_modules', 'playwright-core', 'package.json');
  const version = fs.existsSync(installed) ? JSON.parse(fs.readFileSync(installed, 'utf8')).version : null;
  if (version !== PLAYWRIGHT_VERSION) {
    run('npm', ['install', '--no-audit', '--no-fund', `playwright-core@${PLAYWRIGHT_VERSION}`], WORKSPACE);
  }
}

function setup() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'sonos'))) {
    run('npm', ['install', '--no-audit', '--no-fund'], ROOT);
  }
  setupMagicMirror();
  setupPlaywright();
  console.log(`[e2e setup] MagicMirror ${installedMagicMirrorVersion()} ready in ${path.relative(ROOT, MM_DIR)}`);
}

module.exports = { setup, ROOT, WORKSPACE, MM_DIR };

if (require.main === module) {
  setup();
}
