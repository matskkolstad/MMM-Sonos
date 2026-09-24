'use strict';

const NodeHelper = require('node_helper');
const Log = require('logger');
const { AsyncDeviceDiscovery, Sonos } = require('sonos');
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
  },

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case 'SONOS_CONFIG':
        this._configure(this._mergeInstanceConfig(payload || {}));
        break;
      case 'SONOS_REQUEST':
        this._handleDataRequest();
        break;
      case 'SONOS_CLEAR_CACHE':
        this._clearAlbumArtCache();
        this.sendSocketNotification('SONOS_CACHE_CLEARED', { timestamp: Date.now() });
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
      const members = [];
      let skipGroup = false;

      if (hiddenGroups.has((id || '').toLowerCase()) || hiddenGroups.has((name || '').toLowerCase())) {
        this.sendDebug('Skipping hidden group', name || id);
        continue;
      }

      for (const member of memberList) {
        const displayName = this._pick(member, ['roomName', 'name', 'ZoneName']);
        if (!displayName) {
          continue;
        }
        if (hiddenSpeakers.has(displayName.toLowerCase())) {
          this.sendDebug('Skipping group because member is hidden', displayName, name);
          skipGroup = true;
          break;
        }
        members.push(displayName);
      }

      if (skipGroup) {
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

        const allowWhenPaused = this.config.showWhenPaused || isTvSource;
        if (state !== 'playing' && !allowWhenPaused) {
          this.sendDebug('Skipping group because it is not playing (and not allowed when paused)', name || id, state, {
            isTvSource
          });
          continue;
        }

        if (state === 'stopped' && this.config.hideWhenNothingPlaying && !isTvSource) {
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
                streamContent = raw.trim();
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
        const streamTitle = track?.streamTitle || streamContent || null;

        // Determine display title and artist depending on source type
        let displayTitle;
        let displayArtist;
        if (isTvSource) {
          displayTitle = 'TV';
          displayArtist = null;
        } else if (isRadioSource) {
          // track.title for a radio stream is often a raw URI or empty — prefer stationName
          const rawTitle = track?.title || '';
          const titleIsUseless =
            !rawTitle ||
            /^https?:\/\//i.test(rawTitle) ||
            /^x-sonosapi/i.test(rawTitle) ||
            /^aac:/i.test(rawTitle) ||
            /^hls-radio:/i.test(rawTitle) ||
            /^x-rincon/i.test(rawTitle);
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
        formatted.push({
          id: id || coordinator.uuid || coordinator.host,
          name: name || coordinatorName || 'Sonos',
          coordinatorHost: coordinator.host || null,
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
          members: members.length ? members : [coordinatorName || name || 'Sonos']
        });
      } catch (error) {
        this.sendDebug('Failed to fetch data for group', name || id, error?.message || error);
      }
    }
    // maxGroups is applied by each frontend instance after its own allowed/hidden
    // filters; limiting here could drop the only group an instance is allowed to show.
    return formatted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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
