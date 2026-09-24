'use strict';

/**
 * Unit tests for node_helper.js.
 *
 * The real node_helper.js is loaded through test/helpers/load-module.js, which
 * only stubs the MagicMirror-provided `node_helper` and `logger` modules. Every
 * method under test is the production implementation.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadNodeHelper } = require('./helpers/load-module');

// Wait until `predicate` returns true (for code paths that use async fs callbacks).
async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('_pick()', () => {
  const helper = loadNodeHelper();

  it('returns value for first matching key', () => {
    assert.equal(helper._pick({ Name: 'Living Room' }, ['Name', 'name']), 'Living Room');
  });

  it('falls back to lowercase key lookup', () => {
    assert.equal(helper._pick({ name: 'Kitchen' }, ['Name']), 'Kitchen');
  });

  it('returns null for missing keys', () => {
    assert.equal(helper._pick({ foo: 'bar' }, ['Name', 'name']), null);
  });

  it('returns null for null source', () => {
    assert.equal(helper._pick(null, ['name']), null);
  });

  it('skips null/undefined values and continues', () => {
    assert.equal(helper._pick({ Name: null, name: 'Bedroom' }, ['Name', 'name']), 'Bedroom');
  });
});

describe('_parseTimeToSeconds()', () => {
  const helper = loadNodeHelper();

  it('parses standard time string correctly', () => {
    assert.equal(helper._parseTimeToSeconds('1:23:45'), 5025);
  });

  it('parses zero hours correctly', () => {
    assert.equal(helper._parseTimeToSeconds('0:02:30'), 150);
  });

  it('returns null for NOT_IMPLEMENTED', () => {
    assert.equal(helper._parseTimeToSeconds('NOT_IMPLEMENTED'), null);
  });

  it('returns 0 for 0:00:00 (track at start — position is 0, not unknown)', () => {
    assert.equal(helper._parseTimeToSeconds('0:00:00'), 0);
  });

  it('returns null for non-string input', () => {
    assert.equal(helper._parseTimeToSeconds(null), null);
    assert.equal(helper._parseTimeToSeconds(undefined), null);
    assert.equal(helper._parseTimeToSeconds(123), null);
  });

  it('returns null for malformed string', () => {
    assert.equal(helper._parseTimeToSeconds('bad:input'), null);
    assert.equal(helper._parseTimeToSeconds(''), null);
    assert.equal(helper._parseTimeToSeconds('1:2'), null);
  });
});

describe('_normalizeArt()', () => {
  const helper = loadNodeHelper();

  it('returns absolute HTTP URL unchanged', () => {
    const url = 'http://192.168.1.100:1400/getaa?s=1&u=x-rincon-cpcontainer%3A';
    assert.equal(helper._normalizeArt(url, {}), url);
  });

  it('returns absolute HTTPS URL unchanged', () => {
    const url = 'https://example.com/art.jpg';
    assert.equal(helper._normalizeArt(url, {}), url);
  });

  it('returns data URI unchanged', () => {
    const url = 'data:image/png;base64,abc123';
    assert.equal(helper._normalizeArt(url, {}), url);
  });

  it('constructs absolute URL from relative path', () => {
    const result = helper._normalizeArt('/getaa?s=1', { host: '192.168.1.10', port: 1400 });
    assert.equal(result, 'http://192.168.1.10:1400/getaa?s=1');
  });

  it('adds a leading slash when the relative path has none', () => {
    const result = helper._normalizeArt('getaa?s=1', { host: '192.168.1.10', port: 1400 });
    assert.equal(result, 'http://192.168.1.10:1400/getaa?s=1');
  });

  it('uses https when forceHttps is enabled', () => {
    const httpsHelper = loadNodeHelper({ forceHttps: true });
    const result = httpsHelper._normalizeArt('/getaa?s=1', { host: '192.168.1.10', port: 1400 });
    assert.equal(result, 'https://192.168.1.10:1400/getaa?s=1');
  });

  it('returns relative path as-is when no coordinator host', () => {
    assert.equal(helper._normalizeArt('/getaa?s=1', {}), '/getaa?s=1');
  });

  it('returns null for null input', () => {
    assert.equal(helper._normalizeArt(null, {}), null);
  });

  it('returns null for non-string input', () => {
    assert.equal(helper._normalizeArt(42, {}), null);
  });
});

describe('_generateCacheKey()', () => {
  const helper = loadNodeHelper();

  it('returns hash, ext, and filename for jpg URL', () => {
    const { hash, ext, filename } = helper._generateCacheKey('http://192.168.1.10:1400/art.jpg');
    assert.equal(ext, 'jpg');
    assert.match(filename, /^[a-f0-9]{24}\.jpg$/);
    assert.equal(filename, `${hash}.jpg`);
  });

  it('extracts png extension', () => {
    const { ext } = helper._generateCacheKey('http://example.com/cover.png?v=1');
    assert.equal(ext, 'png');
  });

  it('defaults to jpg for unknown extension', () => {
    const { ext } = helper._generateCacheKey('http://192.168.1.10:1400/getaa?s=1');
    assert.equal(ext, 'jpg');
  });

  it('produces consistent hash for same URL', () => {
    const url = 'http://192.168.1.10:1400/art.jpg';
    assert.equal(helper._generateCacheKey(url).hash, helper._generateCacheKey(url).hash);
  });

  it('produces different hashes for different URLs', () => {
    const { hash: hash1 } = helper._generateCacheKey('http://host1/art.jpg');
    const { hash: hash2 } = helper._generateCacheKey('http://host2/art.jpg');
    assert.notEqual(hash1, hash2);
  });

  it('produces a filename that is safe for the filesystem', () => {
    const { filename } = helper._generateCacheKey('http://192.168.1.10:1400/getaa?s=1&u=spotify%3Atrack%3Aabc');
    assert.match(filename, /^[a-f0-9]{24}\.(jpg|jpeg|png|gif|webp|svg)$/);
  });
});

describe('_isTvTrack()', () => {
  const helper = loadNodeHelper();

  it('returns true when title is "tv"', () => {
    assert.equal(helper._isTvTrack({ title: 'TV' }), true);
  });

  it('returns true for htastream URI', () => {
    assert.equal(helper._isTvTrack({ uri: 'x-sonos-htastream:RINCON_000E58123456:spdif' }), true);
  });

  it('returns true for type "tv"', () => {
    assert.equal(helper._isTvTrack({ type: 'tv' }), true);
  });

  it('returns false for regular track', () => {
    assert.equal(helper._isTvTrack({ title: 'My Song', artist: 'Artist', uri: 'x-file-cifs:/music/song.mp3' }), false);
  });

  it('returns false for null input', () => {
    assert.equal(helper._isTvTrack(null), false);
  });
});

describe('_detectSource()', () => {
  const helper = loadNodeHelper();

  it('returns "tv" for TV track', () => {
    assert.equal(helper._detectSource({ title: 'TV' }), 'tv');
  });

  it('returns "radio" for x-sonosapi-stream URI', () => {
    assert.equal(helper._detectSource({ uri: 'x-sonosapi-stream:s24896?sid=254&flags=8224&sn=0' }), 'radio');
  });

  it('returns "radio" for x-sonosapi-hls URI', () => {
    assert.equal(helper._detectSource({ uri: 'x-sonosapi-hls:something' }), 'radio');
  });

  it('returns "radio" for x-rincon-mp3radio URI', () => {
    assert.equal(helper._detectSource({ uri: 'x-rincon-mp3radio://stream.example.com/live.mp3' }), 'radio');
  });

  it('returns "radio" for tunein URI', () => {
    assert.equal(helper._detectSource({ uri: 'http://opml.radiotime.com/tune.ashx?id=s1234' }), 'radio');
  });

  it('returns "radio" for aac: URI', () => {
    assert.equal(helper._detectSource({ uri: 'aac:http://stream.example.com/radio' }), 'radio');
  });

  it('returns "radio" when stationName is set and no URI', () => {
    assert.equal(helper._detectSource({ stationName: 'NRK P3' }), 'radio');
  });

  it('returns "spotify" for Spotify URI', () => {
    assert.equal(helper._detectSource({ uri: 'x-sonos-spotify:spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC?sid=12&flags=8224&sn=1' }), 'spotify');
  });

  it('returns "apple_music" for nds:music: URI', () => {
    assert.equal(helper._detectSource({ uri: 'nds:music:applemusic:track:123' }), 'apple_music');
  });

  it('returns "apple_music" for URI containing "apple"', () => {
    assert.equal(helper._detectSource({ uri: 'x-apple-itunes:something' }), 'apple_music');
  });

  // Issue #53: on-demand tracks from Apple Music / Amazon Music use x-sonosapi-hls-static:
  // and must not be treated as radio (radio shows the album/station name as title).
  it('returns "apple_music" for an Apple Music track (x-sonosapi-hls-static, sid=204)', () => {
    assert.equal(helper._detectSource({ uri: 'x-sonosapi-hls-static:song%3a1440818839?sid=204&flags=8224&sn=3' }), 'apple_music');
  });

  it('does not treat an Amazon Music track (x-sonosapi-hls-static, sid=201) as radio', () => {
    const uri = 'x-sonosapi-hls-static:catalog%2ftracks%2fB0DHJ4X6ZK%2f%3falbumAsin%3dB0DHJ3XFQR?sid=201&flags=0&sn=4';
    assert.notEqual(helper._detectSource({ uri }), 'radio');
  });

  it('does not treat a TIDAL/Deezer track (x-sonos-http) as radio', () => {
    assert.notEqual(helper._detectSource({ uri: 'x-sonos-http:track%3a12345.mp4?sid=174&flags=8224&sn=5' }), 'radio');
  });

  it('returns "spotify" based on the Spotify service id (sid=12)', () => {
    assert.equal(helper._detectSource({ uri: 'x-sonos-http:something?sid=12&flags=8224&sn=1' }), 'spotify');
  });

  it('returns "radio" for Sonos Radio (x-sonosapi-radio)', () => {
    assert.equal(helper._detectSource({ uri: 'x-sonosapi-radio:sonos%3a123?sid=303&flags=8300&sn=9' }), 'radio');
  });

  it('returns "radio" for an Apple Music radio station (x-sonosapi-hls, sid=204)', () => {
    assert.equal(helper._detectSource({ uri: 'x-sonosapi-hls:radio%3ara.978194965?sid=204&flags=8300&sn=3' }), 'radio');
  });

  it('does not treat a local file whose path contains "/Radio…" as radio', () => {
    assert.equal(helper._detectSource({ uri: 'x-file-cifs://nas/Music/Radiohead/OK%20Computer/01.flac' }), null);
  });

  it('returns null for local library track', () => {
    assert.equal(helper._detectSource({ uri: 'x-file-cifs://nas/music/song.mp3', type: 'track' }), null);
  });

  it('returns null for unknown source', () => {
    assert.equal(helper._detectSource({ uri: 'x-file-cifs://nas/music/song.mp3' }), null);
  });

  it('returns null for null input', () => {
    assert.equal(helper._detectSource(null), null);
  });
});

describe('_parseDIDL()', () => {
  const helper = loadNodeHelper();
  const sampleXml = `
    <DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
      <item>
        <dc:title>NRK P3</dc:title>
        <upnp:albumArtURI>/getaa?s=1&amp;u=something</upnp:albumArtURI>
        <r:streamContent xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">Sigrid – Burning Bridges</r:streamContent>
      </item>
    </DIDL-Lite>
  `;

  it('parses dc:title from DIDL-Lite XML', () => {
    assert.equal(helper._parseDIDL(sampleXml, 'dc:title'), 'NRK P3');
  });

  it('parses upnp:albumArtURI from DIDL-Lite XML', () => {
    assert.equal(helper._parseDIDL(sampleXml, 'upnp:albumArtURI'), '/getaa?s=1&amp;u=something');
  });

  it('parses r:streamContent from DIDL-Lite XML', () => {
    assert.equal(helper._parseDIDL(sampleXml, 'r:streamContent'), 'Sigrid – Burning Bridges');
  });

  it('returns null for missing element', () => {
    assert.equal(helper._parseDIDL(sampleXml, 'dc:missing'), null);
  });

  it('returns null for null XML input', () => {
    assert.equal(helper._parseDIDL(null, 'dc:title'), null);
  });

  it('returns null for non-string XML input', () => {
    assert.equal(helper._parseDIDL(42, 'dc:title'), null);
  });

  it('returns null for empty XML string', () => {
    assert.equal(helper._parseDIDL('', 'dc:title'), null);
  });

  it('returns null when element has empty value', () => {
    assert.equal(helper._parseDIDL('<dc:title></dc:title>', 'dc:title'), null);
  });

  it('trims whitespace from element value', () => {
    assert.equal(helper._parseDIDL('<dc:title>  Radio One  </dc:title>', 'dc:title'), 'Radio One');
  });
});

describe('_buildRadioArtUrl()', () => {
  const helper = loadNodeHelper();
  const coordinator = { host: '192.168.1.10', port: 1400 };

  it('builds correct HTTP URL for radio stream', () => {
    const url = helper._buildRadioArtUrl('x-sonosapi-stream:s1234', coordinator);
    assert.equal(url, 'http://192.168.1.10:1400/getaa?s=1&u=x-sonosapi-stream%3As1234');
  });

  it('builds HTTPS URL when forceHttps is true', () => {
    const url = loadNodeHelper({ forceHttps: true })._buildRadioArtUrl('x-sonosapi-stream:s1234', coordinator);
    assert.equal(url, 'https://192.168.1.10:1400/getaa?s=1&u=x-sonosapi-stream%3As1234');
  });

  it('uses default port 1400 when not specified', () => {
    const url = helper._buildRadioArtUrl('x-sonosapi-stream:s1234', { host: '192.168.1.10' });
    assert.equal(url, 'http://192.168.1.10:1400/getaa?s=1&u=x-sonosapi-stream%3As1234');
  });

  it('URL-encodes the stream URI', () => {
    const url = helper._buildRadioArtUrl('x-sonosapi-stream:s=1&q=test', coordinator);
    assert.ok(url.includes('x-sonosapi-stream%3As%3D1%26q%3Dtest'));
  });

  it('returns null for empty stream URI', () => {
    assert.equal(helper._buildRadioArtUrl('', coordinator), null);
  });

  it('returns null when coordinator host is missing', () => {
    assert.equal(helper._buildRadioArtUrl('x-sonosapi-stream:s1234', {}), null);
  });

  it('returns null for null stream URI', () => {
    assert.equal(helper._buildRadioArtUrl(null, coordinator), null);
  });
});

describe('Album art cache – filesystem', () => {
  let tmpDir;

  // Each test gets its own cache directory so tests cannot see each other's files.
  const makeHelper = (config = {}) => {
    const helper = loadNodeHelper(config);
    const cacheDir = fs.mkdtempSync(path.join(tmpDir, 'cache-'));
    helper._getCacheDir = () => cacheDir;
    return { helper, cacheDir };
  };

  const writeAged = (dir, name, ageMs) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, 'data');
    const time = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, time, time);
    return filePath;
  };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-sonos-cache-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('_ensureCacheDir creates the cache directory when it does not exist', () => {
    const { helper, cacheDir } = makeHelper();
    const nested = path.join(cacheDir, 'nested', 'album-art');
    helper._getCacheDir = () => nested;
    helper._ensureCacheDir();
    assert.equal(fs.existsSync(nested), true);
  });

  it('_cleanupCache removes files older than the TTL and keeps newer ones', async () => {
    const { helper, cacheDir } = makeHelper({ albumArtCacheTTL: 60 * 1000 });
    const oldFile = writeAged(cacheDir, 'old.jpg', 10 * 60 * 1000);
    const newFile = writeAged(cacheDir, 'new.jpg', 1000);

    helper._cleanupCache();

    await waitFor(() => !fs.existsSync(oldFile));
    assert.equal(fs.existsSync(newFile), true);
  });

  it('_cleanupCache keeps everything when TTL is 0 (cache forever)', async () => {
    const { helper, cacheDir } = makeHelper({ albumArtCacheTTL: 0 });
    const oldFile = writeAged(cacheDir, 'forever.jpg', 365 * 24 * 60 * 60 * 1000);

    helper._cleanupCache();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(fs.existsSync(oldFile), true);
  });

  it('_cleanupCache falls back to the default TTL (30 days) when TTL is not set', async () => {
    const { helper, cacheDir } = makeHelper({});
    const day = 24 * 60 * 60 * 1000;
    const expired = writeAged(cacheDir, 'expired.jpg', 31 * day);
    const fresh = writeAged(cacheDir, 'fresh.jpg', 29 * day);

    helper._cleanupCache();

    await waitFor(() => !fs.existsSync(expired));
    assert.equal(fs.existsSync(fresh), true);
  });

  it('_clearAlbumArtCache removes all files and empties the in-memory cache', () => {
    const { helper, cacheDir } = makeHelper();
    helper.albumArtCache.set('abc', 'abc.jpg');
    for (const name of ['a.jpg', 'b.png', 'c.jpg']) {
      fs.writeFileSync(path.join(cacheDir, name), 'fake-data');
    }

    helper._clearAlbumArtCache();

    assert.equal(fs.readdirSync(cacheDir).length, 0);
    assert.equal(helper.albumArtCache.size, 0);
  });
});

describe('_cacheAlbumArt()', () => {
  let tmpDir;
  let helper;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-sonos-art-'));
    helper = loadNodeHelper({ cacheAlbumArt: true });
    helper._getCacheDir = () => tmpDir;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns non-HTTP URLs unchanged', async () => {
    assert.equal(await helper._cacheAlbumArt('data:image/png;base64,abc'), 'data:image/png;base64,abc');
    assert.equal(await helper._cacheAlbumArt(null), null);
  });

  it('returns the local module URL for a file that is already cached on disk', async () => {
    const url = 'http://192.168.1.10:1400/getaa?s=1&u=abc';
    const { filename } = helper._generateCacheKey(url);
    fs.writeFileSync(path.join(tmpDir, filename), 'image');

    const result = await helper._cacheAlbumArt(url);

    assert.equal(result, `/modules/MMM-Sonos/cache/album-art/${filename}`);
  });

  it('falls back to the original URL when the download fails', async () => {
    helper._downloadFile = () => Promise.reject(new Error('boom'));
    const url = 'http://192.168.1.10:1400/getaa?s=1&u=missing';

    assert.equal(await helper._cacheAlbumArt(url), url);
  });
});
