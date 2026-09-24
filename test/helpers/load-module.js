'use strict';

/**
 * Loaders that give tests access to the REAL module code without a running
 * MagicMirror² instance.
 *
 * - loadNodeHelper(): requires node_helper.js with the MagicMirror-provided
 *   `node_helper` and `logger` modules replaced by lightweight stubs, and
 *   returns a fresh helper instance whose socket notifications are recorded.
 * - loadFrontendModule(): evaluates MMM-Sonos.js in a sandbox, captures the
 *   definition passed to Module.register() and returns a fresh instance with
 *   the module defaults merged with the given config.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE_HELPER_PATH = path.join(ROOT, 'node_helper.js');
const FRONTEND_PATH = path.join(ROOT, 'MMM-Sonos.js');

const logger = {
  log() {},
  info() {},
  warn() {},
  error() {},
  debug() {}
};

const nodeHelperStub = {
  // MagicMirror's NodeHelper.create() returns a class; for tests the plain
  // definition object is enough because we instantiate it via Object.create().
  create(definition) {
    return definition;
  }
};

const STUBS = {
  node_helper: nodeHelperStub,
  logger
};

function requireWithStubs(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) {
      return STUBS[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

let helperDefinition = null;

function loadNodeHelper(config = {}) {
  if (!helperDefinition) {
    helperDefinition = requireWithStubs(NODE_HELPER_PATH);
  }
  const helper = Object.create(helperDefinition);
  helper.config = { ...config };
  helper.albumArtCache = new Map();
  helper.accentColorCache = new Map();
  helper.notifications = [];
  helper.sendSocketNotification = (notification, payload) => {
    helper.notifications.push({ notification, payload });
  };
  return helper;
}

let frontendDefinition = null;

function loadFrontendModule(config = {}) {
  if (!frontendDefinition) {
    const source = fs.readFileSync(FRONTEND_PATH, 'utf8');
    const sandbox = {
      Module: {
        register(name, definition) {
          frontendDefinition = definition;
        }
      },
      console
    };
    vm.runInNewContext(source, sandbox, { filename: FRONTEND_PATH });
    if (!frontendDefinition) {
      throw new Error('MMM-Sonos.js did not call Module.register()');
    }
  }
  const instance = Object.create(frontendDefinition);
  instance.config = { ...frontendDefinition.defaults, ...config };
  instance.groups = [];
  instance.lastUpdated = null;
  instance.identifier = 'module_test_MMM-Sonos';
  instance.translate = (key) => key;
  instance.sendSocketNotification = () => {};
  return instance;
}

module.exports = { loadNodeHelper, loadFrontendModule, ROOT };
