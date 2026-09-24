'use strict';

const NodeHelper = require('node_helper');
const Log = require('logger');
const { AsyncDeviceDiscovery, Sonos, Helpers: SonosHelpers } = require('sonos');
const path = require('node:path');
const fs = require('node:fs');
const nodeCrypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { Vibrant } = require('node-vibrant/node');

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 10 * 1000;
const DEFAULT_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

// Track URI prefixes Sonos uses for live radio streams.
const RADIO_URI_PREFIXES = [
  'x-sonosapi-stream:',
  'x-sonosapi-radio:',
  'x-sonosapi-hls:',
  'x-sonosapi-rtd:',
  'x-rincon-mp3radio:',
  'aac:',
  'hls-radio:'
];

// Sonos music service IDs (the `sid` parameter in track URIs) for sources the
// frontend has a label for.
const MUSIC_SERVICE_IDS = {
  12: 'spotify',
  204: 'apple_music'
};

module.exports = NodeHelper.create({
  start() {
    this.config = {};
    this.discovery = null;
    this.coordinator = null;
    this.updateTimer = null;
    this.isDiscovering = false;
    this.lastPayload = [];
    this.lastPayloadAt = null;
    this._refreshPromise = null;
    this.favorites = [];
    this.favoritesTimer = null;
    this.albumArtCache = new Map(); // in-memory cache: url-hash → local filename
    this.accentColorCache = new Map(); // in-memory cache: filename → { r, g, b } | null

    const fallbackConfig = this._readConfigFromFile();
    if (fallbackConfig) {
      this._configure(this._mergeInstanceConfig(fallbackConfig)).catch((error) => {
        this.sendError('Failed to start MMM-Sonos with fallback config', error);
      });
    }
  },

  async stop() {
    this._clearTimer();
    if (this.favoritesTimer) {
      clearInterval(this.favoritesTimer);
      this.favoritesTimer = null;
    }
  },

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case 'SONOS_CONFIG':
        this._configure(this._mergeInstanceConfig(payload || {}));
        if (this._favoritesLoaded) {
          this.sendSocketNotification('SONOS_FAVORITES', { favorites: this.favorites, timestamp: Date.now() });
        }
        break;
      case 'SONOS_REQUEST':
        this._handleDataRequest();
        break;
      case 'SONOS_CLEAR_CACHE':
        this._clearAlbumArtCache();
        this.sendSocketNotification('SONOS_CACHE_CLEARED', { timestamp: Date.now() });
        break;
      case 'SONOS_CONTROL_PLAY':
        this._handlePlay(payload?.zoneId);
        break;
      case 'SONOS_CONTROL_PAUSE':
        this._handlePause(payload?.zoneId);
        break;
      case 'SONOS_CONTROL_SET_VOLUME':
        this._handleSetVolume(payload?.zoneId, payload?.volume);
        break;
      case 'SONOS_CONTROL_SET_MEMBER_VOLUME':
        this._handleSetMemberVolume(payload?.zoneId, payload?.memberName, payload?.volume);
        break;
      case 'SONOS_CONTROL_JOIN_GROUP':
        this._handleJoinGroup(payload?.zoneId, payload?.targetZoneId);
        break;
      case 'SONOS_CONTROL_LEAVE_GROUP':
        this._handleLeaveGroup(payload?.zoneId, payload?.memberName);
        break;
      case 'SONOS_CONTROL_PLAY_FAVORITE':
        this._handlePlayFavorite(payload?.zoneId, payload?.favoriteId);
        break;
    }
  },

  // node_helper is shared by every MMM-Sonos instance on the mirror, but each instance
  // sends its own config. Remember them all and combine the options that decide what
  // node_helper fetches, so one instance's settings do not switch features off for another.
  // Each instance still applies its own filters (allowed/hidden speakers, paused groups)
  // in the browser.
  _mergeInstanceConfig(config) {
    if (!this.instanceConfigs) {
      this.instanceConfigs = new Map();
    }
    const { instanceId, ...instanceConfig } = config;
    if (instanceId) {
      // The config.js fallback read at startup is superseded once real instances connect.
      this.instanceConfigs.delete('config.js');
    }
    this.instanceConfigs.set(instanceId || 'config.js', instanceConfig);
    return this._combineConfigs([...this.instanceConfigs.values()]);
  },

  _combineConfigs(configs) {
    const latest = configs[configs.length - 1] || {};
    const anyEnabled = (key) => configs.some((c) => !!c[key]);
    // Hide a speaker/group in node_helper only when every instance hides it.
    const hiddenByAll = (key) => {
      const lists = configs.map((c) => (Array.isArray(c[key]) ? c[key].map((v) => String(v).toLowerCase()) : []));
      return lists.length ? lists.reduce((acc, list) => acc.filter((v) => list.includes(v))) : [];
    };
    return {
      ...latest,
      showWhenPaused: anyEnabled('showWhenPaused'),
      albumArtColors: anyEnabled('albumArtColors'),
      enableControls: anyEnabled('enableControls'),
      debug: anyEnabled('debug'),
      hiddenSpeakers: hiddenByAll('hiddenSpeakers'),
      hiddenGroups: hiddenByAll('hiddenGroups')
    };
  },

  async _configure(config) {
    this.config = Object.assign(
      {
        updateInterval: 15 * 1000,
        discoveryTimeout: 5 * 1000,
        hiddenSpeakers: [],
        hiddenGroups: [],
        knownDevices: [],
        maxGroups: 6,
        showWhenPaused: false,
        hideWhenNothingPlaying: true,
        enableControls: false,
        favoritesRefreshInterval: 300000,
        forceHttps: false,
        showTvSource: true,
        showTvIcon: true,
        tvIcon: '📺',
        tvLabel: null,
        debug: false,
        cacheAlbumArt: true,
        albumArtCacheTTL: DEFAULT_CACHE_TTL,
        clearCacheOnStart: false
      },
      config
    );

    this.sendDebug('Configuration updated', this.config);

    if (this.config.debug) {
      Log.log(`[MMM-Sonos] Configuration: ${JSON.stringify(this.config)}`);
    }

    this._clearTimer();

    // Track whether the coordinator was already known BEFORE this configure call.
    // When already known, we call _refresh() immediately (line below) and skip
    // the second _refresh() at the end of this function to avoid a double-animation.
    const coordinatorWasKnown = !!this.coordinator;

    // If a coordinator is already known from a previous discovery or startup,
    // skip the blocking re-discovery and serve data immediately. This prevents
    // a 5-second stall every time the frontend reconnects and sends SONOS_CONFIG.
    // A background re-discovery still runs so any device changes are picked up.
    if (this.coordinator) {
      this.sendDebug('Coordinator already known — skipping blocking re-discovery');
      this._refresh();
      // Background re-discovery: update coordinator silently without blocking
      this._discover().catch((error) => {
        this.sendDebug('Background re-discovery failed', error?.message || error);
      });
    } else {
      await this._discover();
    }

    if (this.config.cacheAlbumArt) {
      if (this.config.clearCacheOnStart) {
        this._clearAlbumArtCache();
      } else {
        this._cleanupCache();
      }
    }

    if (!this.updateTimer) {
      this.updateTimer = setInterval(() => this._refresh(), Math.max(this.config.updateInterval, 5000));
    }

    if (this.config.enableControls) {
      this._refreshFavorites();
      if (!this.favoritesTimer) {
        this.favoritesTimer = setInterval(
          () => this._refreshFavorites(),
          Math.max(this.config.favoritesRefreshInterval || 300000, 60000)
        );
      }
    } else if (this.favoritesTimer) {
      clearInterval(this.favoritesTimer);
      this.favoritesTimer = null;
    }

    // Only call _refresh() here when the coordinator was NOT already known above.
    // When it was already known, _refresh() was already called above to serve data
    // immediately — calling it again here would cause a double-refresh and double-animation.
    if (!coordinatorWasKnown) {
      this._refresh();
    }
  },

  async _discover() {
    if (this.isDiscovering) {
      return;
    }

    this.isDiscovering = true;
    this.sendDebug('Starting Sonos discovery');

    try {
      if (this.config.discoveryTimeout !== 0) {
        this.discovery = new AsyncDeviceDiscovery();
        const autoDevice = await this.discovery.discover({ timeout: this.config.discoveryTimeout });
        if (autoDevice) {
          this.coordinator = autoDevice;
          this.sendDebug('Discovered Sonos device via network search', {
            host: this.coordinator.host,
            port: this.coordinator.port,
            name: this.coordinator.name
          });
        }
      }
    } catch (error) {
      this.sendError('Discovery failed', error);
    } finally {
      if (!this.coordinator) {
        const fallback = await this._discoverViaKnownDevices();
        if (fallback) {
          this.coordinator = fallback;
          this.sendDebug('Found Sonos device via knownDevices', {
            host: this.coordinator.host,
            port: this.coordinator.port
          });
        }
      }

      if (!this.coordinator) {
        this.sendDebug('No Sonos device found');
      }

      this.isDiscovering = false;
    }
  },

  async _discoverViaKnownDevices() {
    const hosts = Array.isArray(this.config.knownDevices) ? this.config.knownDevices : [];
    for (const host of hosts) {
      if (!host) {
        continue;
      }
      try {
        const device = new Sonos(host);
        await device.getCurrentState().catch(async () => {
          await device.deviceDescription();
        });
        return device;
      } catch (error) {
        this.sendDebug('Unable to reach known device', host, error?.message || error);
      }
    }
    return null;
  },

  _readConfigFromFile() {
    try {
      const configPath = path.resolve(__dirname, '..', '..', 'config', 'config.js');
      delete require.cache[configPath];
      const fullConfig = require(configPath);
      const moduleEntry = (fullConfig.modules || []).find((entry) => entry.module === 'MMM-Sonos');
      return moduleEntry?.config ? { ...moduleEntry.config } : null;
    } catch (error) {
      this.sendDebug('Could not read config from config.js', error?.message || error);
      return null;
    }
  },

  // Every module instance asks for data on its own timer, while node_helper also
  // refreshes on its own timer and broadcasts the result to all instances. Answer a
  // request with the latest data while it is still fresh instead of polling the
  // speakers again for every instance.
  _handleDataRequest() {
    const maxAge = Math.max(this.config.updateInterval || 0, 5000);
    if (this.lastPayloadAt && Date.now() - this.lastPayloadAt < maxAge) {
      this.sendSocketNotification('SONOS_DATA', { groups: this.lastPayload, timestamp: this.lastPayloadAt });
      return;
    }
    this._refresh();
  },

  // Only one refresh runs at a time; callers that arrive meanwhile share its result.
  _refresh() {
    if (!this._refreshPromise) {
      this._refreshPromise = this._doRefresh().finally(() => {
        this._refreshPromise = null;
      });
    }
    return this._refreshPromise;
  },

  async _doRefresh() {
    if (!this.coordinator) {
      await this._discover();
      if (!this.coordinator) {
        return;
      }
    }

    try {
      const groups = await this.coordinator.getAllGroups();
      const formatted = await this._mapGroups(groups);

      if (!formatted.length && this.config.hideWhenNothingPlaying) {
        this.sendDebug('No active groups found. Sending empty payload.');
      }

      if (this.config.debug) {
        Log.log(`[MMM-Sonos] Sending groups: ${JSON.stringify(formatted)}`);
      }

      this.lastPayload = formatted;
      this.lastPayloadAt = Date.now();
      if (this.config.enableControls && !this._favoritesLoaded && Date.now() >= (this._favoritesRetryAt || 0)) {
        this._refreshFavorites();
      }
      this.sendSocketNotification('SONOS_DATA', {
        groups: formatted,
        timestamp: this.lastPayloadAt
      });
    } catch (error) {
      this.sendError('Failed to fetch Sonos data', error);
      this.coordinator = null; // Force re-discovery on the next refresh
      this.lastPayloadAt = null; // Answer the next request with a fresh poll, not old data
    }
  },

  // Only one favorites fetch runs at a time; callers that arrive meanwhile share it.
  _refreshFavorites() {
    if (!this.coordinator) {
      // No speaker found yet: _doRefresh() fetches favorites once one is found,
      // instead of leaving the list empty until the next favoritesRefreshInterval.
      return Promise.resolve();
    }
    if (!this._favoritesPromise) {
      this._favoritesPromise = this._fetchFavorites().finally(() => {
        this._favoritesPromise = null;
      });
    }
    return this._favoritesPromise;
  },

  // Favorites are the same for the whole household, but not every device can list them
  // (a Sub, surround speakers or a Boost answer with an error). Try the speaker found at
  // discovery first, then each zone coordinator.
  _favoritesSources() {
    const sources = [this.coordinator];
    const seen = new Set([`${this.coordinator?.host}:${this.coordinator?.port || 1400}`]);
    for (const zone of this.lastPayload || []) {
      const key = `${zone.coordinatorHost}:${zone.coordinatorPort || 1400}`;
      if (zone.coordinatorHost && !seen.has(key)) {
        seen.add(key);
        sources.push(new Sonos(zone.coordinatorHost, zone.coordinatorPort || 1400));
      }
    }
    return sources.filter(Boolean);
  },

  async _fetchFavorites() {
    let lastError = null;
    for (const source of this._favoritesSources()) {
      try {
        this.favorites = await this._browseFavorites(source);
        this._favoritesLoaded = true;
        this._favoritesRetryAt = 0;
        this.sendSocketNotification('SONOS_FAVORITES', { favorites: this.favorites, timestamp: Date.now() });
        return;
      } catch (error) {
        lastError = error;
        this.sendDebug('Could not load favorites from', source.host, this._describeError(error));
      }
    }
    // Do not ask again on every refresh; try again in 30 s.
    this._favoritesRetryAt = Date.now() + 30 * 1000;
    Log.warn(`[MMM-Sonos] Could not load Sonos favorites: ${this._describeError(lastError)}`);
  },

  async _browseFavorites(source) {
    // Browse FV:2 directly instead of getFavorites(): the latter drops the metadata
    // (<r:resMD>) Sonos stores with each favorite, which is needed to play playlists
    // and most service favorites.
    const result = await source.contentDirectoryService().Browse({
      ObjectID: 'FV:2',
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: '0',
      RequestedCount: '100',
      SortCriteria: ''
    });
    const didl = await SonosHelpers.ParseXml(result?.Result || '');
    const items = didl?.['DIDL-Lite']?.item;
    return this._mapFavorites(
      (Array.isArray(items) ? items : items ? [items] : []).map((item) => ({
        id: item.id,
        title: item['dc:title'],
        uri: typeof item.res === 'object' ? item.res?._ : item.res,
        metadata: item['r:resMD'] || ''
      }))
    );
  },

  // Shorten UPnP errors (the sonos package includes the whole SOAP envelope) to their code.
  _describeError(error) {
    const message = error?.message || String(error);
    const code = message.match(/<errorCode>(\d+)<\/errorCode>/)?.[1];
    if (code) {
      return `UPnP error ${code}`;
    }
    return /statusCode 500/.test(message) ? 'UPnP error (no code)' : message;
  },

  // Playlists, albums and similar favorites (x-rincon-cpcontainer:) cannot be set as the
  // transport URI — Sonos rejects them. Like the Sonos app, replace the queue with them
  // and play the queue. Streams are set directly, with their metadata so the speaker
  // knows the station name and service.
  _isContainerFavorite(favorite) {
    return /^x-rincon-cpcontainer:/i.test(favorite.uri || '') || /object\.container/i.test(favorite.metadata || '');
  },

  async _playFavorite(device, zone, favorite) {
    const metadata = favorite.metadata || '';
    // Name the step that failed, so a report from a real system says what Sonos rejected.
    const step = async (name, action) => {
      try {
        return await action();
      } catch (error) {
        const upnpClass = metadata.match(/<upnp:class>([^<]*)<\/upnp:class>/)?.[1] || 'unknown class';
        throw new Error(`${name}: ${this._describeError(error)} (favorite "${favorite.title}", ${upnpClass}, ${favorite.uri})`, { cause: error });
      }
    };
    if (this._isContainerFavorite(favorite)) {
      // A speaker can only play its own queue. The group ID does not tell which speaker
      // that is: Sonos keeps the ID of the speaker that created the group, which after
      // regrouping need not be the coordinator. Ask the speaker itself.
      const coordinatorUuid = await step('identify speaker', () => this._speakerUuid(device, zone));
      await step('clear queue', () => device.flush());
      await step('add to queue', () => device.queue({ uri: favorite.uri, metadata }));
      await step('select queue', () => device.setAVTransportURI({ uri: `x-rincon-queue:${coordinatorUuid}#0`, metadata: '', onlySetUri: true }));
      await step('select track', () => device.selectTrack(1));
      await step('play', () => device.play());
      return;
    }
    await step('play stream', () => device.setAVTransportURI({ uri: favorite.uri, metadata }));
  },

  // Sonos reports placeholders such as ZPSTR_CONNECTING / ZPSTR_BUFFERING while a
  // stream starts; they are status codes, not something to show as "now playing".
  _cleanStreamText(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const text = value.trim();
    return !text || /^ZPSTR_/i.test(text) ? null : text;
  },

  async _speakerUuid(device, zone) {
    try {
      const description = await device.deviceDescription();
      const uuid = String(description?.UDN || '').replace(/^uuid:/, '');
      if (uuid) {
        return uuid;
      }
    } catch (error) {
      this.sendDebug('Could not read device description', device.host, this._describeError(error));
    }
    return zone.coordinatorUuid || String(zone.id || '').split(':')[0];
  },

  _mapFavorites(items) {
    return (items || [])
      .map((item, index) => ({
        id: item.id || `favorite-${index}`,
        title: item.title || 'Untitled',
        uri: item.uri,
        metadata: item.metadata || ''
      }))
      .filter((f) => !!f.uri);
  },

  // After a control action, fetch fresh state so the change shows up right away. A
  // refresh that is already running started before the action, so queue a new one
  // after it instead of sharing its (now stale) result.
  _refreshAfterControl() {
    this.lastPayloadAt = null;
    if (this._refreshPromise) {
      this._refreshPromise.then(() => this._refresh());
    } else {
      this._refresh();
    }
  },

  // Sonos accepts integer volumes 0–100; anything else from the browser is rejected.
  _sanitizeVolume(volume) {
    const value = Number(volume);
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.min(100, Math.max(0, Math.round(value)));
  },

  async _handlePlay(zoneId) {
    const zone = this._findZone(zoneId);
    if (!zone || !zone.coordinatorHost) {
      this._sendControlResult(zoneId, 'play', false, 'Zone not found');
      return;
    }
    try {
      await new Sonos(zone.coordinatorHost, zone.coordinatorPort || 1400).play();
      this._sendControlResult(zoneId, 'play', true);
      this._refreshAfterControl();
    } catch (error) {
      this._sendControlResult(zoneId, 'play', false, error?.message || String(error));
    }
  },

  async _handlePause(zoneId) {
    const zone = this._findZone(zoneId);
    if (!zone || !zone.coordinatorHost) {
      this._sendControlResult(zoneId, 'pause', false, 'Zone not found');
      return;
    }
    try {
      await new Sonos(zone.coordinatorHost, zone.coordinatorPort || 1400).pause();
      this._sendControlResult(zoneId, 'pause', true);
      this._refreshAfterControl();
    } catch (error) {
      this._sendControlResult(zoneId, 'pause', false, error?.message || String(error));
    }
  },

  async _handleSetVolume(zoneId, rawVolume) {
    const volume = this._sanitizeVolume(rawVolume);
    if (volume === null) {
      this._sendControlResult(zoneId, 'setVolume', false, 'Invalid volume');
      return;
    }
    const zone = this._findZone(zoneId);
    if (!zone) {
      this._sendControlResult(zoneId, 'setVolume', false, 'Zone not found');
      return;
    }
    const targets = (zone.memberDetails || [])
      .filter((m) => m.host)
      .map((m) => ({ host: m.host, port: m.port || 1400 }));
    if (!targets.length && zone.coordinatorHost) {
      targets.push({ host: zone.coordinatorHost, port: zone.coordinatorPort || 1400 });
    }
    if (!targets.length) {
      this._sendControlResult(zoneId, 'setVolume', false, 'No reachable speakers in zone');
      return;
    }
    try {
      await Promise.all(targets.map((target) => new Sonos(target.host, target.port).setVolume(volume)));
      this._sendControlResult(zoneId, 'setVolume', true);
    } catch (error) {
      this._sendControlResult(zoneId, 'setVolume', false, error?.message || String(error));
    }
  },

  async _handleSetMemberVolume(zoneId, memberName, rawVolume) {
    const volume = this._sanitizeVolume(rawVolume);
    if (volume === null) {
      this._sendControlResult(zoneId, 'setMemberVolume', false, 'Invalid volume');
      return;
    }
    const zone = this._findZone(zoneId);
    if (!zone) {
      this._sendControlResult(zoneId, 'setMemberVolume', false, 'Zone not found');
      return;
    }
    const target = this._resolveMemberTarget(zone, memberName);
    if (!target) {
      this._sendControlResult(zoneId, 'setMemberVolume', false, 'Speaker not found in zone');
      return;
    }
    try {
      await new Sonos(target.host, target.port).setVolume(volume);
      this._sendControlResult(zoneId, 'setMemberVolume', true);
    } catch (error) {
      this._sendControlResult(zoneId, 'setMemberVolume', false, error?.message || String(error));
    }
  },

  async _handleJoinGroup(zoneId, targetZoneId) {
    const zone = this._findZone(zoneId);
    const targetZone = this._findZone(targetZoneId);
    const plan = this._resolveJoinGroupPlan(zone, targetZone);
    if (plan.error) {
      this._sendControlResult(zoneId, 'joinGroup', false, plan.error);
      return;
    }
    try {
      // Move every member of the target zone individually — joinGroup() moves only the
      // one device it's called on, so joining just the target's coordinator would strand
      // its own followers (if the target itself already has more than one speaker)
      // instead of bringing all of them into the current group.
      await Promise.all(
        plan.targetMembers.map((member) => new Sonos(member.host, member.port).joinGroup(plan.anchorRoomName))
      );
      this._sendControlResult(zoneId, 'joinGroup', true);
      this._refreshAfterControl();
    } catch (error) {
      this._sendControlResult(zoneId, 'joinGroup', false, error?.message || String(error));
    }
  },

  async _handleLeaveGroup(zoneId, memberName) {
    const zone = this._findZone(zoneId);
    const target = this._resolveLeaveGroupTarget(zone, memberName);
    if (target.error) {
      this._sendControlResult(zoneId, 'leaveGroup', false, target.error);
      return;
    }
    try {
      await new Sonos(target.host, target.port).leaveGroup();
      this._sendControlResult(zoneId, 'leaveGroup', true);
      this._refreshAfterControl();
    } catch (error) {
      this._sendControlResult(zoneId, 'leaveGroup', false, error?.message || String(error));
    }
  },

  async _handlePlayFavorite(zoneId, favoriteId) {
    const zone = this._findZone(zoneId);
    if (!zone || !zone.coordinatorHost) {
      this._sendControlResult(zoneId, 'playFavorite', false, 'Zone not found');
      return;
    }
    const favorite = (this.favorites || []).find((f) => f.id === favoriteId);
    if (!favorite) {
      this._sendControlResult(zoneId, 'playFavorite', false, 'Favorite not found');
      return;
    }
    try {
      await this._playFavorite(new Sonos(zone.coordinatorHost, zone.coordinatorPort || 1400), zone, favorite);
      this._sendControlResult(zoneId, 'playFavorite', true);
      // Without this, the overlay only learns the new track on the next regular poll
      // tick (up to `updateInterval`, e.g. 15s) — same pattern as join/leave.
      this._refreshAfterControl();
    } catch (error) {
      this._sendControlResult(zoneId, 'playFavorite', false, error?.message || String(error));
    }
  },

  async _mapGroups(groups) {
    if (!Array.isArray(groups)) {
      return [];
    }

    const hiddenGroups = new Set((this.config.hiddenGroups || []).map((item) => item.toLowerCase()));
    const hiddenSpeakers = new Set((this.config.hiddenSpeakers || []).map((item) => item.toLowerCase()));

    const formatted = [];

    for (const group of groups) {
      const id = this._pick(group, ['ID', 'Id', 'id', 'ZoneGroupID', 'GroupID']);
      const name =
        this._pick(group, ['Name', 'name', 'ZoneGroupName', 'GroupName']) ||
        this._pick(group?.Coordinator, ['roomName', 'name']);

      const coordinator = this._resolveCoordinator(group);
      const membersRaw =
        group.ZoneGroupMembers ||
        group.ZoneGroupMember ||
        group.members ||
        group.children ||
        [];
      const memberList = Array.isArray(membersRaw)
        ? membersRaw
        : typeof membersRaw === 'object'
        ? Object.values(membersRaw)
        : [];
      if (hiddenGroups.has((id || '').toLowerCase()) || hiddenGroups.has((name || '').toLowerCase())) {
        this.sendDebug('Skipping hidden group', name || id);
        continue;
      }

      const { members, memberDetails, skipGroup } = this._buildMemberDetails(memberList, hiddenSpeakers);
      if (skipGroup) {
        this.sendDebug('Skipping group because a member is hidden', name || id);
        continue;
      }

      if (!coordinator) {
        this.sendDebug('No coordinator for group', name || id);
        continue;
      }

      try {
        const stateRaw = await coordinator.getCurrentState();
        const state = typeof stateRaw === 'string' ? stateRaw.toLowerCase() : 'unknown';

        const track = await coordinator.currentTrack();
        const source = this._detectSource(track);
        const isTvSource = source === 'tv';

        const allowWhenPaused = this.config.showWhenPaused || isTvSource || this.config.enableControls;
        if (state !== 'playing' && !allowWhenPaused) {
          this.sendDebug('Skipping group because it is not playing (and not allowed when paused)', name || id, state, {
            isTvSource
          });
          continue;
        }

        if (state === 'stopped' && this.config.hideWhenNothingPlaying && !isTvSource && !this.config.enableControls) {
          this.sendDebug('Hiding stopped group because hideWhenNothingPlaying is enabled', name || id);
          continue;
        }

        const albumArtRaw = this._normalizeArt(track?.albumArtURL || track?.absoluteAlbumArtURI, coordinator);

        // For radio: currentTrack() often returns null for all metadata fields.
        // Fetch GetMediaInfo() which carries the station name and logo in DIDL-Lite XML,
        // and GetPositionInfo().TrackMetaData which may carry a live "now playing" string.
        const isRadioSource = source === 'radio';
        let mediaInfoTitle = null;
        let mediaInfoArtUri = null;
        let streamContent = null;

        if (isRadioSource) {
          try {
            const avt = coordinator.avTransportService();
            const [mediaInfo, posInfo] = await Promise.all([
              avt.GetMediaInfo().catch(() => null),
              avt.GetPositionInfo().catch(() => null)
            ]);

            if (mediaInfo?.CurrentURIMetaData) {
              mediaInfoTitle = this._parseDIDL(mediaInfo.CurrentURIMetaData, 'dc:title');
              const rawArtUri = this._parseDIDL(mediaInfo.CurrentURIMetaData, 'upnp:albumArtURI');
              if (rawArtUri) {
                mediaInfoArtUri = this._normalizeArt(rawArtUri, coordinator);
              }
            }

            if (posInfo?.TrackMetaData) {
              const raw = this._parseDIDL(posInfo.TrackMetaData, 'r:streamContent');
              if (raw && raw.trim()) {
                streamContent = this._cleanStreamText(raw);
              }
            }

            this.sendDebug('AVTransport MediaInfo parsed', { mediaInfoTitle, mediaInfoArtUri, streamContent });
          } catch (mediaError) {
            this.sendDebug('Failed to fetch MediaInfo for radio', mediaError?.message || mediaError);
          }
        }

        // Best art: track-reported > DIDL from MediaInfo > /getaa fallback
        const radioArtFallback = (isRadioSource && !albumArtRaw && !mediaInfoArtUri && track?.uri)
          ? this._buildRadioArtUrl(track.uri, coordinator)
          : null;

        const effectiveArtRaw = albumArtRaw || mediaInfoArtUri || radioArtFallback;
        const albumArt = (this.config.cacheAlbumArt && effectiveArtRaw)
          ? await this._cacheAlbumArt(effectiveArtRaw)
          : effectiveArtRaw;

        // Log the full raw track object in debug mode
        if (this.config.debug) {
          Log.log(`[MMM-Sonos] Raw track object: ${JSON.stringify(track)}`);
        }

        // Station name: DIDL title is most reliable, then fall back to track fields
        const stationName =
          mediaInfoTitle ||
          track?.stationName ||
          track?.album ||
          track?.albumArtist ||
          null;
        const streamTitle = this._cleanStreamText(track?.streamTitle) || streamContent || null;

        // Determine display title and artist depending on source type
        let displayTitle;
        let displayArtist;
        if (isTvSource) {
          displayTitle = 'TV';
          displayArtist = null;
        } else if (isRadioSource) {
          // track.title for a radio stream is often a raw URI or empty — prefer stationName
          const rawTitle = this._cleanStreamText(track?.title) || '';
          const titleIsUseless =
            !rawTitle ||
            /^https?:\/\//i.test(rawTitle) ||
            /^x-sonosapi/i.test(rawTitle) ||
            /^aac:/i.test(rawTitle) ||
            /^hls-radio:/i.test(rawTitle) ||
            /^x-rincon/i.test(rawTitle) ||
            // Some stations report the end of the stream URL as title, e.g.
            // "P04_MM?args=3rdparty_03" for x-rincon-mp3radio://…/P04_MM?args=3rdparty_03
            (!!track?.uri && track.uri.endsWith(`/${rawTitle}`));
          // Priority: stationName (from DIDL) > usable rawTitle > streamTitle > 'Radio'
          displayTitle = stationName || (titleIsUseless ? (streamTitle || 'Radio') : rawTitle);
          // streamTitle / streamContent (e.g. "Sigrid – Burning Bridges") as artist line
          displayArtist =
            track?.artist ||
            (streamTitle && streamTitle !== displayTitle ? streamTitle : null);
        } else {
          displayTitle = track?.title || null;
          displayArtist = track?.artist || null;
        }

        this.sendDebug('Radio metadata', {
          source,
          rawTitle: track?.title,
          stationName,
          streamTitle,
          mediaInfoTitle,
          mediaInfoArtUri,
          streamContent,
          albumArtURL: track?.albumArtURL,
          radioArtFallback,
          displayTitle,
          displayArtist
        });

        // Get volume and position information
        let volume = null;
        let position = null;
        let duration = null;

        try {
          volume = await coordinator.getVolume();
        } catch (error) {
          this.sendDebug('Failed to fetch volume', name || id, error?.message || error);
        }

        // currentTrack() already read GetPositionInfo, so reuse its position/duration
        // instead of asking the speaker again. Values Sonos reports as NOT_IMPLEMENTED
        // (e.g. for some streams) arrive as NaN and are treated as unknown.
        if (!isTvSource) {
          position = Number.isFinite(track?.position) ? track.position : null;
          duration = Number.isFinite(track?.duration) ? track.duration : null;
        }

        // Extract dominant accent color from locally cached album art when enabled
        let accentColor = null;
        if (this.config.albumArtColors && albumArt && albumArt.startsWith('/modules/')) {
          const artFilename = albumArt.split('/').pop();
          const artFilePath = path.join(this._getCacheDir(), artFilename);
          accentColor = await this._extractAccentColor(artFilePath);
        }

        // Only ask the speaker for its room name when the group data lacks one.
        const coordinatorName = (!name || !members.length) ? await this._inferCoordinatorName(coordinator) : null;
        const effectiveMembers = members.length ? members : [coordinatorName || name || 'Sonos'];
        let effectiveMemberDetails = memberDetails.length
          ? memberDetails
          : [{ name: effectiveMembers[0], host: coordinator.host || null, port: coordinator.port || 1400 }];

        // Per-speaker volumes are only needed by the touch-control overlay, so skip the
        // extra network round trips (one getVolume() per member) unless controls are on.
        if (this.config.enableControls && effectiveMemberDetails.length > 1) {
          effectiveMemberDetails = await Promise.all(
            effectiveMemberDetails.map(async (member) => {
              if (!member.host) {
                return { ...member, volume: null };
              }
              try {
                const memberVolume = await new Sonos(member.host, member.port || 1400).getVolume();
                return { ...member, volume: memberVolume };
              } catch (error) {
                this.sendDebug('Failed to fetch member volume', member.name, error?.message || error);
                return { ...member, volume: null };
              }
            })
          );
        }

        formatted.push({
          id: id || coordinator.uuid || coordinator.host,
          name: name || coordinatorName || 'Sonos',
          coordinatorHost: coordinator.host || null,
          coordinatorPort: coordinator.port || 1400,
          coordinatorUuid: typeof group.Coordinator === 'string' ? group.Coordinator : null,
          memberDetails: effectiveMemberDetails,
          playbackState: state,
          title: displayTitle,
          artist: displayArtist,
          album: track?.album || null,
          albumArt,
          accentColor,
          source,
          isTvSource,
          stationName,
          streamTitle,
          volume,
          position,
          duration,
          members: effectiveMembers
        });
      } catch (error) {
        this.sendDebug('Failed to fetch data for group', name || id, error?.message || error);
      }
    }
    // maxGroups is applied by each frontend instance after its own allowed/hidden
    // filters; limiting here could drop the only group an instance is allowed to show.
    return formatted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  },

  _findZone(zoneId) {
    return (this.lastPayload || []).find((z) => z.id === zoneId) || null;
  },

  _sendControlResult(zoneId, action, success, error) {
    if (!success) {
      Log.warn(`[MMM-Sonos] Control action "${action}" failed for zone ${zoneId}: ${this._describeError(error)}`);
    }
    this.sendSocketNotification('SONOS_CONTROL_RESULT', { zoneId, action, success, error: error || null });
  },

  _resolveCoordinator(group) {
    if (!group) {
      return null;
    }

    if (typeof group.CoordinatorDevice === 'function') {
      try {
        return group.CoordinatorDevice();
      } catch (error) {
        this.sendDebug('Failed to resolve coordinator from CoordinatorDevice()', error?.message || error);
      }
    }

    const direct = this._pick(group, ['Coordinator', 'coordinator', 'Leader']);
    if (direct && typeof direct.getCurrentState === 'function') {
      return direct;
    }

    if (group.host) {
      try {
        return new Sonos(group.host, group.port || 1400);
      } catch (error) {
        this.sendDebug('Failed to create Sonos instance from host', group.host, error?.message || error);
      }
    }

    return null;
  },

  _resolveMemberHost(member) {
    const location = this._pick(member, ['Location', 'location']);
    if (!location) {
      return null;
    }
    try {
      const url = new URL(location);
      return { host: url.hostname, port: url.port ? parseInt(url.port, 10) : 1400 };
    } catch (error) {
      this.sendDebug('Failed to parse member location', location, error?.message || error);
      return null;
    }
  },

  // Builds `members` (display names) and `memberDetails` ({name, host, port}) from the
  // same pass over the raw member list, so a member always pairs with the right host even
  // when its location can't be resolved — the two used to be built as separate arrays that
  // could silently desync.
  _buildMemberDetails(memberList, hiddenSpeakers) {
    const members = [];
    const memberDetails = [];
    let skipGroup = false;
    for (const member of memberList) {
      const displayName = this._pick(member, ['roomName', 'name', 'ZoneName']);
      if (!displayName) continue;
      if (hiddenSpeakers.has(displayName.toLowerCase())) {
        skipGroup = true;
        break;
      }
      members.push(displayName);
      const host = this._resolveMemberHost(member);
      memberDetails.push({ name: displayName, host: host ? host.host : null, port: host ? host.port : null });
    }
    return { members, memberDetails, skipGroup };
  },

  // Finds the {host, port} of one named member within a zone, for per-speaker volume and
  // leave-group actions that must target a single device rather than the whole group.
  _resolveMemberTarget(zone, memberName) {
    if (!zone || !memberName) return null;
    const target = (zone.memberDetails || []).find(
      (m) => (m.name || '').toLowerCase() === memberName.toLowerCase()
    );
    if (!target || !target.host) return null;
    return { host: target.host, port: target.port || 1400 };
  },

  _resolveLeaveGroupTarget(zone, memberName) {
    if (!zone) return { error: 'Zone not found' };
    if ((zone.memberDetails || []).length <= 1) {
      return { error: 'Zone has only one speaker' };
    }
    const target = this._resolveMemberTarget(zone, memberName);
    if (!target) return { error: 'Speaker not found in zone' };
    return { host: target.host, port: target.port };
  },

  // joinGroup() called on a device moves only THAT device to follow a new coordinator —
  // it does not bring that device's own followers with it. So merging target zone T into
  // the currently-open zone G must move every one of T's member devices individually to
  // join G (using one of G's own room names as the anchor), never a member of G itself —
  // otherwise, if G already has more than one speaker, redirecting G's own coordinator to
  // join something else abandons G's other members instead of extending the group.
  _resolveJoinGroupPlan(zone, targetZone) {
    if (!zone || !(zone.members || []).length) return { error: 'Zone not found' };
    if (!targetZone) return { error: 'Target zone not found' };
    if (targetZone.id === zone.id) return { error: 'Already in that group' };
    const anchorRoomName = zone.members[0];
    const targetMembers = (targetZone.memberDetails || []).filter((m) => m.host);
    if (!targetMembers.length) return { error: 'Target zone has no reachable speakers' };
    return { anchorRoomName, targetMembers };
  },

  async _inferCoordinatorName(coordinator) {
    if (!coordinator) {
      return null;
    }
    try {
      const description = await coordinator.deviceDescription();
      return description?.roomName || description?.displayName || coordinator.name || coordinator.host;
    } catch (error) {
      this.sendDebug('Unable to fetch coordinator name', error?.message || error);
      return coordinator.name || coordinator.host;
    }
  },

  _normalizeArt(uri, coordinator) {
    if (!uri || typeof uri !== 'string') {
      return null;
    }

    if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('data:')) {
      return uri;
    }

    const proto = this.config.forceHttps ? 'https' : 'http';
    const host = coordinator?.host;
    const port = coordinator?.port || 1400;

    if (!host) {
      return uri;
    }

    return `${proto}://${host}:${port}${uri.startsWith('/') ? uri : `/${uri}`}`;
  },

  // Parse a single element value from a DIDL-Lite XML string.
  // e.g. _parseDIDL(xml, 'dc:title') → 'NRK P3'
  _parseDIDL(xml, element) {
    if (!xml || typeof xml !== 'string') {
      return null;
    }
    // Match both <ns:tag>value</ns:tag> and <tag>value</tag>
    const tag = element.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
    if (!match) {
      return null;
    }
    const value = match[1].trim();
    return value || null;
  },

  // Build the Sonos device's /getaa URL which returns the station logo for radio streams.
  // This works for most services where Sonos stores artwork locally.
  _buildRadioArtUrl(streamUri, coordinator) {
    if (!streamUri || !coordinator?.host) {
      return null;
    }
    const proto = this.config.forceHttps ? 'https' : 'http';
    const host = coordinator.host;
    const port = coordinator.port || 1400;
    return `${proto}://${host}:${port}/getaa?s=1&u=${encodeURIComponent(streamUri)}`;
  },

  _detectSource(track) {
    if (!track || typeof track !== 'object') {
      return null;
    }

    if (this._isTvTrack(track)) {
      return 'tv';
    }

    // Check URI patterns first — more reliable than track.type which may be generic (e.g. 'track')
    const uri = (track.uri || '').toLowerCase();
    if (uri) {
      // Only prefixes Sonos uses for live streams count as radio. In particular
      // x-sonosapi-hls-static: is NOT radio: Apple Music and Amazon Music use it for
      // ordinary on-demand tracks, and treating those as radio replaced the track
      // title with the album name (issue #53).
      if (
        RADIO_URI_PREFIXES.some((prefix) => uri.startsWith(prefix)) ||
        uri.includes('tunein') ||
        uri.includes('radiotime')
      ) {
        return 'radio';
      }

      const serviceId = uri.match(/[?&]sid=(\d+)/)?.[1];
      if (serviceId && MUSIC_SERVICE_IDS[serviceId]) {
        return MUSIC_SERVICE_IDS[serviceId];
      }

      if (uri.includes('spotify')) {
        return 'spotify';
      }

      if (uri.includes('apple') || uri.startsWith('nds:music:') || uri.includes('applemusic')) {
        return 'apple_music';
      }
    }

    // Fall back to track.type only when it carries meaningful info (not generic 'track'/'audio')
    const type = (track.type || track.metadata?.type || '').toLowerCase();
    if (type && type !== 'track' && type !== 'audio') {
      return type;
    }

    // A stationName being set is a strong additional indicator of a radio stream
    if (track.stationName) {
      return 'radio';
    }

    return null;
  },

  _isTvTrack(track) {
    if (!track || typeof track !== 'object') {
      return false;
    }

    const type = (track.type || track.metadata?.type || '').toLowerCase();
    const title = (track.title || '').toLowerCase();
    const uri = (track.uri || '').toLowerCase();
    const station = (track.stationName || track.streamTitle || '').toLowerCase();
    const protocol = (track.metadata?.protocolInfo || '').toLowerCase();

    if (title === 'tv' || station === 'tv') {
      return true;
    }

    if (uri.includes('x-sonos-htastream:') || uri.includes('x-sonos-htastream')) {
      return true;
    }

    if (uri.includes(':spdif') || uri.includes(':hdmi')) {
      return true;
    }

    if (protocol.includes('htastream')) {
      return true;
    }

    if (type === 'tv' || type === 'ht' || type === 'home theater') {
      return true;
    }

    if (type === 'line_in' && (title === 'tv' || uri.includes('htastream') || station === 'tv')) {
      return true;
    }

    return false;
  },

  _pick(source, keys) {
    if (!source) {
      return null;
    }
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) {
        return source[key];
      }
      const lower = key.toLowerCase();
      if (source[lower] !== undefined && source[lower] !== null) {
        return source[lower];
      }
    }
    return null;
  },

  _getCacheDir() {
    return path.join(__dirname, 'cache', 'album-art');
  },

  _ensureCacheDir() {
    const dir = this._getCacheDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  },

  _generateCacheKey(url) {
    const hash = nodeCrypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
    const urlPath = url.split('?')[0];
    const extMatch = urlPath.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    return { hash, ext, filename: `${hash}.${ext}` };
  },

  async _cacheAlbumArt(url) {
    if (!url || typeof url !== 'string') {
      return url;
    }

    // Only cache HTTP/HTTPS URLs — skip data URIs or already-local URLs
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return url;
    }

    try {
      const { hash, filename } = this._generateCacheKey(url);
      const localUrl = `/modules/MMM-Sonos/cache/album-art/${filename}`;

      // Return cached result if already known in memory
      if (this.albumArtCache.has(hash)) {
        return localUrl;
      }

      this._ensureCacheDir();
      const cachePath = path.join(this._getCacheDir(), filename);

      // Check filesystem cache
      if (fs.existsSync(cachePath)) {
        this.albumArtCache.set(hash, filename);
        return localUrl;
      }

      // Download and store
      await this._downloadFile(url, cachePath);
      this.albumArtCache.set(hash, filename);
      this.sendDebug('Cached album art', { url, localUrl });
      return localUrl;
    } catch (error) {
      this.sendDebug('Failed to cache album art, using original URL', url, error?.message || error);
      return url;
    }
  },

  _downloadFile(url, destPath, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const tmpPath = `${destPath}.tmp`;
      const file = fs.createWriteStream(tmpPath);
      let settled = false;

      const fail = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        file.close();
        fs.unlink(tmpPath, () => {});
        reject(err);
      };

      const doRequest = (requestUrl, redirectCount) => {
        if (redirectCount > MAX_REDIRECTS) {
          fail(new Error('Too many redirects'));
          return;
        }

        const protocol = requestUrl.startsWith('https://') ? https : http;
        const request = protocol.get(requestUrl, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            // Location may be relative to the requested URL
            doRequest(new URL(response.headers.location, requestUrl).toString(), redirectCount + 1);
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            fail(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          response.on('error', fail);
          response.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              fs.rename(tmpPath, destPath, (err) => {
                if (err) {
                  fail(err);
                } else {
                  settled = true;
                  resolve();
                }
              });
            });
          });
          file.on('error', fail);
        });

        // A speaker or server that stops answering must not stall the refresh.
        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error(`Album art download timed out after ${timeoutMs} ms`));
        });
        request.on('error', fail);
      };

      doRequest(url, 0);
    });
  },

  _cleanupCache() {
    const cacheDir = this._getCacheDir();
    if (!fs.existsSync(cacheDir)) {
      return;
    }

    // A TTL of exactly 0 means "cache forever" — skip cleanup entirely
    const ttl = this.config.albumArtCacheTTL;
    if (ttl === 0) {
      this.sendDebug('Album art cache TTL is 0 — skipping cleanup (cache forever)');
      return;
    }

    const effectiveTtl = (ttl && ttl > 0) ? ttl : DEFAULT_CACHE_TTL;
    const now = Date.now();

    try {
      const files = fs.readdirSync(cacheDir);
      for (const file of files) {
        const filePath = path.join(cacheDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > effectiveTtl) {
            fs.unlink(filePath, (err) => {
              if (err) {
                this.sendDebug('Failed to delete expired cache file', file, err?.message || err);
              }
            });
            this.sendDebug('Removed expired cache file', file);
          }
        } catch (statError) {
          this.sendDebug('Failed to stat cache file', file, statError?.message || statError);
        }
      }
    } catch (error) {
      this.sendDebug('Failed to clean up cache directory', error?.message || error);
    }
  },

  _clearAlbumArtCache() {
    this.albumArtCache.clear();
    const cacheDir = this._getCacheDir();
    if (!fs.existsSync(cacheDir)) {
      return;
    }

    try {
      const files = fs.readdirSync(cacheDir);
      for (const file of files) {
        const filePath = path.join(cacheDir, file);
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          this.sendDebug('Failed to delete cache file', file, err?.message || err);
        }
      }
      this.sendDebug('Album art cache cleared', { filesRemoved: files.length });
      Log.log(`[MMM-Sonos] Album art cache cleared (${files.length} file(s) removed)`);
    } catch (error) {
      this.sendDebug('Failed to clear cache directory', error?.message || error);
    }
  },

  _clearTimer() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  },

  // Extract the dominant accent colour from a local album-art image file using node-vibrant.
  // Results are cached in memory (keyed by filename) to avoid re-processing on every poll.
  async _extractAccentColor(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const cacheKey = path.basename(filePath);
    if (this.accentColorCache.has(cacheKey)) {
      return this.accentColorCache.get(cacheKey);
    }

    try {
      const palette = await Vibrant.from(filePath).getPalette();
      // Priority: DarkVibrant (rich, dark) → Vibrant → DarkMuted → Muted
      const swatch = palette.DarkVibrant || palette.Vibrant || palette.DarkMuted || palette.Muted;
      if (!swatch) {
        this.accentColorCache.set(cacheKey, null);
        return null;
      }
      const color = { r: swatch.r, g: swatch.g, b: swatch.b };
      this.accentColorCache.set(cacheKey, color);
      this.sendDebug('Extracted accent color', { filePath: cacheKey, color });
      return color;
    } catch (error) {
      this.sendDebug('Failed to extract accent color', filePath, error?.message || error);
      this.accentColorCache.set(cacheKey, null);
      return null;
    }
  },

  sendDebug(message, meta) {
    if (this.config.debug) {
      this.sendSocketNotification('SONOS_DEBUG', { message, meta });
    }
  },

  sendError(context, error) {
    const payload = {
      context,
      message: error?.message || error || 'Unknown error'
    };
    this.sendSocketNotification('SONOS_ERROR', payload);
  }
});
