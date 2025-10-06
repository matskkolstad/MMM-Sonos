'use strict';

const NodeHelper = require('node_helper');
const Log = require('logger');
const { AsyncDeviceDiscovery, Sonos } = require('sonos');
const path = require('node:path');

module.exports = NodeHelper.create({
  start() {
    this.config = {};
    this.discovery = null;
    this.coordinator = null;
    this.updateTimer = null;
    this.isDiscovering = false;
    this.lastPayload = [];

    const fallbackConfig = this._readConfigFromFile();
    if (fallbackConfig) {
      this._configure(fallbackConfig).catch((error) => {
        this.sendError('Kunne ikke starte MMM-Sonos med fallback-konfig', error);
      });
    }
  },

  async stop() {
    this._clearTimer();
  },

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case 'SONOS_CONFIG':
        this._configure(payload || {});
        break;
      case 'SONOS_REQUEST':
        this._refresh();
        break;
    }
  },

  async _configure(config) {
    Log.log(`[MMM-Sonos] Mottok config: ${JSON.stringify(config)}`);
    this.config = Object.assign(
      {
        updateInterval: 15 * 1000,
        discoveryTimeout: 5 * 1000,
        hiddenSpeakers: [],
        hiddenGroups: [],
        knownDevices: [],
        maxGroups: 6,
        showWhenPaused: true,
        hideWhenNothingPlaying: false,
        forceHttps: false,
        debug: false
      },
      config
    );

    this.sendDebug('Konfigurasjon oppdatert', this.config);

    if (this.config.debug) {
      Log.log(`[MMM-Sonos] Konfigurasjon: ${JSON.stringify(this.config)}`);
    }

    this._clearTimer();
    await this._discover();

    if (!this.updateTimer) {
      this.updateTimer = setInterval(() => this._refresh(), Math.max(this.config.updateInterval, 5000));
    }

    this._refresh();
  },

  async _discover() {
    if (this.isDiscovering) {
      return;
    }

    this.isDiscovering = true;
    this.sendDebug('Starter Sonos discovery');

    try {
      if (this.config.discoveryTimeout !== 0) {
        this.discovery = new AsyncDeviceDiscovery();
        const autoDevice = await this.discovery.discover({ timeout: this.config.discoveryTimeout });
        if (autoDevice) {
          this.coordinator = autoDevice;
          this.sendDebug('Fant Sonos-enhet via nettverks-søk', {
            host: this.coordinator.host,
            port: this.coordinator.port,
            name: this.coordinator.name
          });
        }
      }
    } catch (error) {
      this.sendError('Oppdagelse feilet', error);
    } finally {
      if (!this.coordinator) {
        const fallback = await this._discoverViaKnownDevices();
        if (fallback) {
          this.coordinator = fallback;
          this.sendDebug('Fant Sonos-enhet via knownDevices', {
            host: this.coordinator.host,
            port: this.coordinator.port
          });
        }
      }

      if (!this.coordinator) {
        this.sendDebug('Fant ingen Sonos-enhet');
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
        this.sendDebug('Klarte ikke å nå kjent enhet', host, error?.message || error);
      }
    }
    return null;
  },

  _readConfigFromFile() {
    try {
      const configPath = path.resolve(__dirname, '..', '..', 'config', 'config.js');
      delete require.cache[configPath];
      // eslint-disable-next-line global-require
      const fullConfig = require(configPath);
      const moduleEntry = (fullConfig.modules || []).find((entry) => entry.module === 'MMM-Sonos');
      return moduleEntry?.config ? { ...moduleEntry.config } : null;
    } catch (error) {
      this.sendDebug('Kunne ikke lese config fra config.js', error?.message || error);
      return null;
    }
  },

  async _refresh() {
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
        this.sendDebug('Ingen aktive grupper funnet. Sender tom payload.');
      }

      if (this.config.debug) {
        Log.log(`[MMM-Sonos] Sender grupper: ${JSON.stringify(formatted)}`);
      }

      this.lastPayload = formatted;
      this.sendSocketNotification('SONOS_DATA', {
        groups: formatted,
        timestamp: Date.now()
      });
    } catch (error) {
      this.sendError('Kunne ikke hente Sonos-data', error);
      this.coordinator = null; // Tving re-discovery
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
        this.sendDebug('Hopper over skjult gruppe', name || id);
        continue;
      }

      for (const member of memberList) {
        const displayName = this._pick(member, ['roomName', 'name', 'ZoneName']);
        if (!displayName) {
          continue;
        }
        if (hiddenSpeakers.has(displayName.toLowerCase())) {
          this.sendDebug('Hopper over gruppe fordi medlem er skjult', displayName, name);
          skipGroup = true;
          break;
        }
        members.push(displayName);
      }

      if (skipGroup) {
        continue;
      }

      if (!coordinator) {
        this.sendDebug('Ingen koordinator for gruppe', name || id);
        continue;
      }

      try {
        const stateRaw = await coordinator.getCurrentState();
        const state = typeof stateRaw === 'string' ? stateRaw.toLowerCase() : 'unknown';

        if (state !== 'playing' && !this.config.showWhenPaused) {
          this.sendDebug('Skipper gruppe fordi den ikke spiller', name || id, state);
          continue;
        }
        if (state === 'stopped' && this.config.hideWhenNothingPlaying) {
          this.sendDebug('Skjuler stoppet gruppe fordi hideWhenNothingPlaying er aktiv', name || id);
          continue;
        }

        const track = await coordinator.currentTrack();
        const albumArt = this._normalizeArt(track?.albumArtURL || track?.absoluteAlbumArtURI, coordinator);

        const coordinatorName = await this._inferCoordinatorName(coordinator);
        formatted.push({
          id: id || coordinator.uuid || coordinator.host,
          name: name || coordinatorName || 'Sonos',
          playbackState: state,
          title: track?.title || null,
          artist: track?.artist || null,
          album: track?.album || null,
          albumArt,
          members: members.length ? members : [coordinatorName || name || 'Sonos']
        });
      } catch (error) {
        this.sendDebug('Feilet å hente data for gruppe', name || id, error?.message || error);
      }
    }
  const ordered = formatted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return ordered.slice(0, this.config.maxGroups || ordered.length);
  },

  _resolveCoordinator(group) {
    if (!group) {
      return null;
    }

    if (typeof group.CoordinatorDevice === 'function') {
      try {
        return group.CoordinatorDevice();
      } catch (error) {
        this.sendDebug('Feilet å hente koordinator fra CoordinatorDevice()', error?.message || error);
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
        this.sendDebug('Feilet å bygge Sonos-instans fra host', group.host, error?.message || error);
      }
    }

    return null;
  },

  async _inferCoordinatorName(coordinator) {
    if (!coordinator) {
      return null;
    }
    try {
      const description = coordinator.deviceDescription || (await coordinator.deviceDescription());
      return description?.roomName || description?.displayName || coordinator.name || coordinator.host;
    } catch (error) {
      this.sendDebug('Kunne ikke hente koordinatornavn', error?.message || error);
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

  _clearTimer() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
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
      message: error?.message || error || 'Ukjent feil'
    };
    this.sendSocketNotification('SONOS_ERROR', payload);
  }
});
