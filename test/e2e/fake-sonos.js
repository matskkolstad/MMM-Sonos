'use strict';

/**
 * A small Sonos speaker simulator for end-to-end tests.
 *
 * Each simulated speaker is an HTTP server on 127.0.0.1:<port> that answers the
 * UPnP/SOAP calls MMM-Sonos makes through the `sonos` npm package:
 *
 *   ZoneGroupTopology  GetZoneGroupState
 *   AVTransport        GetTransportInfo, GetPositionInfo, GetMediaInfo
 *   RenderingControl   GetVolume
 *   GET /xml/device_description.xml
 *   GET /art/<name>.png   (album art, generated on the fly)
 *
 * and the control actions used by touch control mode (enableControls):
 *   Play, Pause, SetVolume, SetAVTransportURI (favorites and x-rincon: joins),
 *   BecomeCoordinatorOfStandaloneGroup (leave group), Browse FV:2 (favorites).
 * Control actions change the simulated state, just like on real speakers.
 *
 * The responses mirror the XML a real Sonos speaker returns, so node_helper.js
 * and the sonos package run unmodified against it.
 *
 * Scenarios are plain objects (see test/e2e/scenarios/*.json):
 *   {
 *     "speakers": [{ "uuid", "name", "port" }],
 *     "groups":   [{ "coordinator": uuid, "members": [uuid], "state", "volume",
 *                    "track": { "uri", "title", "artist", "album", "art", "duration", "position",
 *                               "streamContent", "class" },
 *                    "media": { "uri", "title", "art" } }]
 *   }
 * Speakers that are not the coordinator of any group answer transport calls
 * as STOPPED with no media.
 *
 * Usage:
 *   const sim = await startFakeSonos(scenario);
 *   sim.setScenario(otherScenario);   // switch what is "playing"
 *   await sim.close();
 *
 * It can also be run directly for manual testing:
 *   node test/e2e/fake-sonos.js test/e2e/scenarios/mixed-sources.json
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createPng } = require('./png');

const HOST = '127.0.0.1';

const TRANSPORT_STATES = {
  playing: 'PLAYING',
  paused: 'PAUSED_PLAYBACK',
  stopped: 'STOPPED',
  transitioning: 'TRANSITIONING'
};

// Colours used for generated album art, keyed by the `art` name in a scenario.
const ART_COLORS = {
  blue: [[30, 60, 160], [90, 170, 230]],
  red: [[150, 20, 40], [240, 120, 80]],
  green: [[20, 110, 60], [150, 220, 120]],
  purple: [[70, 30, 120], [200, 120, 220]],
  orange: [[190, 80, 10], [250, 200, 90]],
  teal: [[10, 90, 100], [110, 210, 200]]
};

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function soapEnvelope(action, service, body) {
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}Response>` +
    '</s:Body></s:Envelope>'
  );
}

function secondsToTime(total) {
  const seconds = Math.max(0, Math.floor(total));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function artPath(art) {
  if (!art) {
    return null;
  }
  // Absolute URLs are passed through untouched (useful for failure scenarios).
  if (/^https?:\/\//.test(art)) {
    return art;
  }
  return `/art/${encodeURIComponent(art)}.png`;
}

function trackDidl(track) {
  const parts = [
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
      'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">',
    '<item id="-1" parentID="-1" restricted="true">',
    `<res protocolInfo="sonos.com-http:*:audio/mp4:*" duration="${secondsToTime(track.duration || 0)}">${escapeXml(track.uri || '')}</res>`
  ];
  if (track.streamContent !== undefined) {
    parts.push(`<r:streamContent>${escapeXml(track.streamContent)}</r:streamContent>`);
  }
  const art = artPath(track.art);
  if (art) {
    parts.push(`<upnp:albumArtURI>${escapeXml(art)}</upnp:albumArtURI>`);
  }
  if (track.title) {
    parts.push(`<dc:title>${escapeXml(track.title)}</dc:title>`);
  }
  parts.push(`<upnp:class>${escapeXml(track.class || 'object.item.audioItem.musicTrack')}</upnp:class>`);
  if (track.artist) {
    parts.push(`<dc:creator>${escapeXml(track.artist)}</dc:creator>`);
  }
  if (track.album) {
    parts.push(`<upnp:album>${escapeXml(track.album)}</upnp:album>`);
  }
  parts.push('</item></DIDL-Lite>');
  return parts.join('');
}

function mediaDidl(media) {
  const art = artPath(media.art);
  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    '<item id="-1" parentID="-1" restricted="true">' +
    (media.title ? `<dc:title>${escapeXml(media.title)}</dc:title>` : '') +
    '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>' +
    (art ? `<upnp:albumArtURI>${escapeXml(art)}</upnp:albumArtURI>` : '') +
    '</item></DIDL-Lite>'
  );
}

class FakeSonos {
  constructor() {
    this.servers = new Map(); // port -> http.Server
    this.scenario = null;
    this.scenarioStartedAt = Date.now();
    this.requests = []; // { port, action } — handy for assertions/debugging
  }

  setScenario(scenario) {
    // Control actions change the state, so work on a copy.
    this.scenario = JSON.parse(JSON.stringify(scenario));
    this.scenario.groups = this.scenario.groups || [];
    this.scenarioStartedAt = Date.now();
    // Volume is per speaker on Sonos; a group's volume initialises all its members.
    this.volumes = new Map();
    for (const group of this.scenario.groups) {
      for (const uuid of group.members?.length ? group.members : [group.coordinator]) {
        this.volumes.set(uuid, group.volume ?? 20);
      }
    }
  }

  groupContaining(uuid) {
    return this.scenario.groups.find((g) => (g.members?.length ? g.members : [g.coordinator]).includes(uuid)) || null;
  }

  // Remove a speaker from the group it is in. If it coordinated a group with other
  // members, the next member takes over (as on a real system).
  detachSpeaker(uuid) {
    const group = this.groupContaining(uuid);
    if (!group) {
      return;
    }
    const members = (group.members?.length ? group.members : [group.coordinator]).filter((m) => m !== uuid);
    if (!members.length) {
      this.scenario.groups = this.scenario.groups.filter((g) => g !== group);
      return;
    }
    group.members = members;
    if (group.coordinator === uuid) {
      group.coordinator = members[0];
    }
  }

  // Coordinator group for a speaker, creating an idle standalone group if needed.
  ensureOwnGroup(uuid) {
    let group = this.groupForCoordinator(uuid);
    if (!group) {
      this.detachSpeaker(uuid);
      group = { coordinator: uuid, members: [uuid], state: 'stopped' };
      this.scenario.groups.push(group);
    }
    return group;
  }

  favoritesXml() {
    const items = (this.scenario.favorites || []).map((fav, index) =>
      `<item id="FV:2/${index + 1}" parentID="FV:2" restricted="false">` +
      `<dc:title>${escapeXml(fav.title)}</dc:title>` +
      '<upnp:class>object.itemobject.item.sonos-favorite</upnp:class>' +
      (fav.art ? `<upnp:albumArtURI>${escapeXml(artPath(fav.art))}</upnp:albumArtURI>` : '') +
      `<res protocolInfo="x-rincon-mp3radio:*:*:*">${escapeXml(fav.uri)}</res>` +
      '</item>'
    );
    return (
      '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
      'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
      items.join('') +
      '</DIDL-Lite>'
    );
  }

  static soapValue(body, tag) {
    const match = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (!match) {
      return null;
    }
    return match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }

  speakerByPort(port) {
    return (this.scenario?.speakers || []).find((s) => s.port === port) || null;
  }

  groupForCoordinator(uuid) {
    return (this.scenario?.groups || []).find((g) => g.coordinator === uuid) || null;
  }

  async listen(ports) {
    for (const port of ports) {
      if (this.servers.has(port)) {
        continue;
      }
      const server = http.createServer((req, res) => this.handle(port, req, res));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, resolve);
      });
      this.servers.set(port, server);
    }
  }

  async close() {
    await Promise.all(
      [...this.servers.values()].map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          })
      )
    );
    this.servers.clear();
  }

  handle(port, req, res) {
    const url = new URL(req.url, `http://${HOST}:${port}`);

    if (req.method === 'GET' && url.pathname.startsWith('/art/')) {
      return this.serveArt(url, res);
    }

    if (req.method === 'GET' && url.pathname === '/xml/device_description.xml') {
      return this.serveDeviceDescription(port, res);
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => this.handleSoap(port, req, body, res));
      return undefined;
    }

    res.writeHead(404);
    res.end();
    return undefined;
  }

  serveArt(url, res) {
    const name = decodeURIComponent(url.pathname.slice('/art/'.length).replace(/\.png$/, ''));
    const [from, to] = ART_COLORS[name] || ART_COLORS.teal;
    const png = createPng(96, 96, (x, y) => {
      const t = (x + y) / (2 * 95);
      return from.map((c, i) => Math.round(c + (to[i] - c) * t));
    });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
  }

  serveDeviceDescription(port, res) {
    const speaker = this.speakerByPort(port);
    const name = speaker?.name || `Speaker ${port}`;
    const uuid = speaker?.uuid || `RINCON_SIM${port}`;
    const xml =
      '<?xml version="1.0" encoding="utf-8" ?><root xmlns="urn:schemas-upnp-org:device-1-0">' +
      '<specVersion><major>1</major><minor>0</minor></specVersion><device>' +
      '<deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>' +
      `<friendlyName>${HOST} - Sonos Simulator</friendlyName><manufacturer>Sonos, Inc.</manufacturer>` +
      `<modelName>Sonos Simulator</modelName><UDN>uuid:${uuid}</UDN>` +
      `<roomName>${escapeXml(name)}</roomName><displayName>Simulator</displayName>` +
      '</device></root>';
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(xml);
  }

  handleSoap(port, req, body, res) {
    const soapAction = String(req.headers.soapaction || '').replace(/"/g, '');
    const [serviceUrn, action] = soapAction.split('#');
    const service = (serviceUrn || '').split(':').slice(-2, -1)[0];
    this.requests.push({ port, action });

    const speaker = this.speakerByPort(port);
    if (!speaker) {
      res.writeHead(500);
      res.end('Unknown speaker');
      return;
    }

    const group = this.groupForCoordinator(speaker.uuid);
    const reply = (xmlBody) => {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
      res.end(soapEnvelope(action, service, xmlBody));
    };

    switch (action) {
      case 'GetZoneGroupState':
        return reply(`<ZoneGroupState>${escapeXml(this.zoneGroupStateXml())}</ZoneGroupState>`);

      case 'GetTransportInfo': {
        const state = TRANSPORT_STATES[group?.state] || 'STOPPED';
        return reply(
          `<CurrentTransportState>${state}</CurrentTransportState>` +
            '<CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>'
        );
      }

      case 'GetPositionInfo':
        return reply(this.positionInfoXml(group));

      case 'GetMediaInfo': {
        const media = group?.media;
        return reply(
          '<NrTracks>1</NrTracks><MediaDuration>NOT_IMPLEMENTED</MediaDuration>' +
            `<CurrentURI>${escapeXml(media?.uri || group?.track?.uri || '')}</CurrentURI>` +
            `<CurrentURIMetaData>${media?.title || media?.art ? escapeXml(mediaDidl(media)) : ''}</CurrentURIMetaData>` +
            '<NextURI></NextURI><NextURIMetaData></NextURIMetaData>' +
            '<PlayMedium>NETWORK</PlayMedium><RecordMedium>NOT_IMPLEMENTED</RecordMedium>' +
            '<WriteStatus>NOT_IMPLEMENTED</WriteStatus>'
        );
      }

      case 'GetVolume':
        return reply(`<CurrentVolume>${this.volumes.get(speaker.uuid) ?? 20}</CurrentVolume>`);

      // ---- control actions (touch control mode) ----
      case 'SetVolume':
        this.volumes.set(speaker.uuid, Number(FakeSonos.soapValue(body, 'DesiredVolume')));
        return reply('');

      case 'Play':
        if (group) {
          if (group.state !== 'playing') {
            this.scenarioStartedAt = Date.now();
          }
          group.state = 'playing';
        }
        return reply('');

      case 'Pause':
        if (group) {
          group.state = 'paused';
        }
        return reply('');

      case 'BecomeCoordinatorOfStandaloneGroup':
        this.detachSpeaker(speaker.uuid);
        return reply('<DelegatedGroupCoordinatorID></DelegatedGroupCoordinatorID><NewGroupID></NewGroupID>');

      case 'SetAVTransportURI': {
        const uri = FakeSonos.soapValue(body, 'CurrentURI') || '';
        if (uri.startsWith('x-rincon:')) {
          // Join the group coordinated by the given speaker
          const target = this.groupForCoordinator(uri.slice('x-rincon:'.length));
          if (!target) {
            res.writeHead(500);
            res.end('Unknown coordinator');
            return undefined;
          }
          this.detachSpeaker(speaker.uuid);
          target.members = [...(target.members?.length ? target.members : [target.coordinator]), speaker.uuid];
          return reply('');
        }
        const favorite = (this.scenario.favorites || []).find((f) => f.uri === uri);
        const own = this.ensureOwnGroup(speaker.uuid);
        own.track = { uri, title: favorite?.title || uri, class: 'object.item', duration: 0 };
        own.media = { uri, title: favorite?.title, art: favorite?.art };
        own.state = 'stopped';
        return reply('');
      }

      case 'Browse': {
        if (FakeSonos.soapValue(body, 'ObjectID') !== 'FV:2') {
          res.writeHead(500);
          res.end('Unsupported ObjectID');
          return undefined;
        }
        const count = (this.scenario.favorites || []).length;
        return reply(
          `<Result>${escapeXml(this.favoritesXml())}</Result>` +
            `<NumberReturned>${count}</NumberReturned><TotalMatches>${count}</TotalMatches><UpdateID>1</UpdateID>`
        );
      }

      default:
        res.writeHead(500, { 'Content-Type': 'text/xml' });
        res.end(`Unsupported action ${action}`);
        return undefined;
    }
  }

  positionInfoXml(group) {
    const track = group?.track;
    if (!track) {
      return (
        '<Track>0</Track><TrackDuration>0:00:00</TrackDuration><TrackMetaData></TrackMetaData>' +
        '<TrackURI></TrackURI><RelTime>0:00:00</RelTime><AbsTime>NOT_IMPLEMENTED</AbsTime>' +
        '<RelCount>2147483647</RelCount><AbsCount>2147483647</AbsCount>'
      );
    }

    const isPlaying = group.state === 'playing';
    const elapsed = isPlaying ? (Date.now() - this.scenarioStartedAt) / 1000 : 0;
    const duration = track.duration || 0;
    const position = duration ? Math.min(duration, (track.position || 0) + elapsed) : 0;

    return (
      '<Track>1</Track>' +
      `<TrackDuration>${secondsToTime(duration)}</TrackDuration>` +
      `<TrackMetaData>${track.metadata === false ? 'NOT_IMPLEMENTED' : escapeXml(trackDidl(track))}</TrackMetaData>` +
      `<TrackURI>${escapeXml(track.uri || '')}</TrackURI>` +
      `<RelTime>${duration ? secondsToTime(position) : '0:00:00'}</RelTime>` +
      '<AbsTime>NOT_IMPLEMENTED</AbsTime><RelCount>2147483647</RelCount><AbsCount>2147483647</AbsCount>'
    );
  }

  zoneGroupStateXml() {
    const speakers = new Map((this.scenario?.speakers || []).map((s) => [s.uuid, s]));
    const grouped = new Set();
    const groups = (this.scenario?.groups || []).map((group) => {
      const members = group.members?.length ? group.members : [group.coordinator];
      members.forEach((uuid) => grouped.add(uuid));
      return { coordinator: group.coordinator, members };
    });
    // Every speaker that is not in a configured group is its own (idle) group, like on a real system.
    for (const uuid of speakers.keys()) {
      if (!grouped.has(uuid)) {
        groups.push({ coordinator: uuid, members: [uuid] });
      }
    }

    const groupXml = groups
      .map((group, index) => {
        const membersXml = group.members
          .map((uuid) => {
            const speaker = speakers.get(uuid);
            return (
              `<ZoneGroupMember UUID="${uuid}" Location="http://${HOST}:${speaker.port}/xml/device_description.xml" ` +
              `ZoneName="${escapeXml(speaker.name)}" Icon="" Configuration="1" SoftwareVersion="85.0-64200" ` +
              'SWGen="2" MinCompatibleVersion="84.0-00000" LegacyCompatibleVersion="58.0-00000" BootSeq="10" ' +
              'TVConfigurationError="0" HdmiCecAvailable="0" WirelessMode="0" WirelessLeafOnly="0" ' +
              'ChannelFreq="2437" BehindWifiExtender="0" WifiEnabled="1" EthLink="0" Orientation="0" ' +
              'RoomCalibrationState="4" SecureRegState="3" VoiceConfigState="0" MicEnabled="0" ' +
              'AirPlayEnabled="1" IdleState="1" MoreInfo=""/>'
            );
          })
          .join('');
        return `<ZoneGroup Coordinator="${group.coordinator}" ID="${group.coordinator}:${100 + index}">${membersXml}</ZoneGroup>`;
      })
      .join('');

    return `<ZoneGroupState><ZoneGroups>${groupXml}</ZoneGroups><VanishedDevices></VanishedDevices></ZoneGroupState>`;
  }
}

function loadScenario(nameOrPath) {
  const file = nameOrPath.endsWith('.json')
    ? path.resolve(nameOrPath)
    : path.join(__dirname, 'scenarios', `${nameOrPath}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function startFakeSonos(scenario) {
  const sim = new FakeSonos();
  sim.setScenario(scenario);
  await sim.listen(scenario.speakers.map((s) => s.port));
  return sim;
}

module.exports = { startFakeSonos, loadScenario, FakeSonos };

if (require.main === module) {
  const scenario = loadScenario(process.argv[2] || 'mixed-sources');
  startFakeSonos(scenario).then(() => {
    const ports = scenario.speakers.map((s) => `${s.name}@${HOST}:${s.port}`).join(', ');
    console.log(`Fake Sonos running: ${ports}`);
  });
}
