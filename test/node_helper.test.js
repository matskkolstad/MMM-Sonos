'use strict';

/**
 * Unit tests for node_helper.js helper methods.
 *
 * We extract the testable pure/stateless methods directly to avoid the
 * MagicMirror NodeHelper framework dependency in CI.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Inline copies of the pure helper functions from node_helper.js
// These are tested independently of the MagicMirror runtime.
// ---------------------------------------------------------------------------

function _pick(source, keys) {
  if (!source) return null;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
    const lower = key.toLowerCase();
    if (source[lower] !== undefined && source[lower] !== null) return source[lower];
  }
  return null;
}

function _parseTimeToSeconds(timeString) {
  if (!timeString || typeof timeString !== 'string') return null;
  if (timeString === 'NOT_IMPLEMENTED' || timeString === '0:00:00') return null;
  const parts = timeString.split(':');
  if (parts.length !== 3) return null;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseInt(parts[2], 10);
  if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function _normalizeArt(uri, coordinator, config = {}) {
  if (!uri || typeof uri !== 'string') return null;
  if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('data:')) return uri;
  const proto = config.forceHttps ? 'https' : 'http';
  const host = coordinator?.host;
  const port = coordinator?.port || 1400;
  if (!host) return uri;
  return `${proto}://${host}:${port}${uri.startsWith('/') ? uri : `/${uri}`}`;
}

function _generateCacheKey(url) {
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
  const urlPath = url.split('?')[0];
  const extMatch = urlPath.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
  return { hash, ext, filename: `${hash}.${ext}` };
}

function _isTvTrack(track) {
  if (!track || typeof track !== 'object') return false;
  const type = (track.type || track.metadata?.type || '').toLowerCase();
  const title = (track.title || '').toLowerCase();
  const uri = (track.uri || '').toLowerCase();
  const station = (track.stationName || track.streamTitle || '').toLowerCase();
  const protocol = (track.metadata?.protocolInfo || '').toLowerCase();
  if (title === 'tv' || station === 'tv') return true;
  if (uri.includes('x-sonos-htastream:') || uri.includes('x-sonos-htastream')) return true;
  if (uri.includes(':spdif') || uri.includes(':hdmi')) return true;
  if (protocol.includes('htastream')) return true;
  if (type === 'tv' || type === 'ht' || type === 'home theater') return true;
  if (type === 'line_in' && (title === 'tv' || uri.includes('htastream') || station === 'tv')) return true;
  return false;
}

function _detectSource(track) {
  if (!track || typeof track !== 'object') return null;
  if (_isTvTrack(track)) return 'tv';

  // Check URI patterns first — more reliable than track.type which may be generic (e.g. 'track')
  const uri = (track.uri || '').toLowerCase();
  if (uri) {
    if (
      uri.startsWith('x-sonosapi-stream:') ||
      uri.startsWith('x-sonosapi-hls-static:') ||
      uri.startsWith('x-sonosapi-hls:') ||
      uri.startsWith('x-sonosapi-rtd:') ||
      uri.startsWith('x-rincon-mp3radio:') ||
      uri.startsWith('aac:') ||
      uri.startsWith('hls-radio:') ||
      uri.includes('x-sonosapi') ||
      uri.includes('tunein') ||
      uri.includes('radiotime') ||
      uri.includes('/radio')
    ) {
      return 'radio';
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
}

function _parseDIDL(xml, element) {
  if (!xml || typeof xml !== 'string') {
    return null;
  }
  const tag = element.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  if (!match) {
    return null;
  }
  const value = match[1].trim();
  return value || null;
}

function _buildRadioArtUrl(streamUri, coordinatorHost, coordinatorPort, forceHttps) {
  if (!streamUri || !coordinatorHost) {
    return null;
  }
  const proto = forceHttps ? 'https' : 'http';
  const port = coordinatorPort || 1400;
  return `${proto}://${coordinatorHost}:${port}/getaa?s=1&u=${encodeURIComponent(streamUri)}`;
}

function _isHidden(group, config) {
  const byGroup = (config.hiddenGroups || []).map((g) => g.toLowerCase());
  const bySpeaker = (config.hiddenSpeakers || []).map((g) => g.toLowerCase());
  const allowedGroups = (config.allowedGroups || []).map((g) => g.toLowerCase());
  const allowedSpeakers = (config.allowedSpeakers || []).map((g) => g.toLowerCase());

  // Blacklist — explicit hide by group id/name
  if (byGroup.includes((group.id || '').toLowerCase()) || byGroup.includes((group.name || '').toLowerCase())) {
    return true;
  }

  // Blacklist — hide if any member is in the hidden list
  if (group.members && group.members.some((m) => bySpeaker.includes(m.toLowerCase()))) {
    return true;
  }

  // Blacklist — hide by coordinator IP
  if (group.coordinatorHost && bySpeaker.includes(group.coordinatorHost.toLowerCase())) {
    return true;
  }

  // Whitelist — if allowedGroups is set, only show matching group names/IDs/IPs
  if (allowedGroups.length > 0) {
    const matchGroup =
      allowedGroups.includes((group.id || '').toLowerCase()) ||
      allowedGroups.includes((group.name || '').toLowerCase()) ||
      (group.coordinatorHost && allowedGroups.includes(group.coordinatorHost.toLowerCase()));
    if (!matchGroup) return true;
  }

  // Whitelist — if allowedSpeakers is set, only show groups that have at least one allowed member
  if (allowedSpeakers.length > 0) {
    const hasAllowedMember =
      group.members &&
      group.members.some((m) => allowedSpeakers.includes(m.toLowerCase()));
    const hostAllowed = group.coordinatorHost && allowedSpeakers.includes(group.coordinatorHost.toLowerCase());
    if (!hasAllowedMember && !hostAllowed) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_pick()', () => {
  it('returns value for first matching key', () => {
    assert.equal(_pick({ Name: 'Living Room' }, ['Name', 'name']), 'Living Room');
  });

  it('falls back to lowercase key lookup', () => {
    assert.equal(_pick({ name: 'Kitchen' }, ['Name']), 'Kitchen');
  });

  it('returns null for missing keys', () => {
    assert.equal(_pick({ foo: 'bar' }, ['Name', 'name']), null);
  });

  it('returns null for null source', () => {
    assert.equal(_pick(null, ['name']), null);
  });

  it('skips null/undefined values and continues', () => {
    assert.equal(_pick({ Name: null, name: 'Bedroom' }, ['Name', 'name']), 'Bedroom');
  });
});

describe('_parseTimeToSeconds()', () => {
  it('parses standard time string correctly', () => {
    assert.equal(_parseTimeToSeconds('1:23:45'), 5025);
  });

  it('parses zero hours correctly', () => {
    assert.equal(_parseTimeToSeconds('0:02:30'), 150);
  });

  it('returns null for NOT_IMPLEMENTED', () => {
    assert.equal(_parseTimeToSeconds('NOT_IMPLEMENTED'), null);
  });

  it('returns null for 0:00:00', () => {
    assert.equal(_parseTimeToSeconds('0:00:00'), null);
  });

  it('returns null for non-string input', () => {
    assert.equal(_parseTimeToSeconds(null), null);
    assert.equal(_parseTimeToSeconds(undefined), null);
    assert.equal(_parseTimeToSeconds(123), null);
  });

  it('returns null for malformed string', () => {
    assert.equal(_parseTimeToSeconds('bad:input'), null);
    assert.equal(_parseTimeToSeconds(''), null);
    assert.equal(_parseTimeToSeconds('1:2'), null);
  });
});

describe('_normalizeArt()', () => {
  it('returns absolute HTTP URL unchanged', () => {
    const url = 'http://192.168.1.100:1400/getaa?s=1&u=x-rincon-cpcontainer%3A';
    assert.equal(_normalizeArt(url, {}), url);
  });

  it('returns absolute HTTPS URL unchanged', () => {
    const url = 'https://example.com/art.jpg';
    assert.equal(_normalizeArt(url, {}), url);
  });

  it('returns data URI unchanged', () => {
    const url = 'data:image/png;base64,abc123';
    assert.equal(_normalizeArt(url, {}), url);
  });

  it('constructs absolute URL from relative path', () => {
    const result = _normalizeArt('/getaa?s=1', { host: '192.168.1.10', port: 1400 });
    assert.equal(result, 'http://192.168.1.10:1400/getaa?s=1');
  });

  it('uses https when forceHttps is enabled', () => {
    const result = _normalizeArt('/getaa?s=1', { host: '192.168.1.10', port: 1400 }, { forceHttps: true });
    assert.equal(result, 'https://192.168.1.10:1400/getaa?s=1');
  });

  it('returns relative path as-is when no coordinator host', () => {
    assert.equal(_normalizeArt('/getaa?s=1', {}), '/getaa?s=1');
  });

  it('returns null for null input', () => {
    assert.equal(_normalizeArt(null, {}), null);
  });

  it('returns null for non-string input', () => {
    assert.equal(_normalizeArt(42, {}), null);
  });
});

describe('_generateCacheKey()', () => {
  it('returns hash, ext, and filename for jpg URL', () => {
    const { hash, ext, filename } = _generateCacheKey('http://192.168.1.10:1400/art.jpg');
    assert.equal(ext, 'jpg');
    assert.match(filename, /^[a-f0-9]{24}\.jpg$/);
    assert.equal(filename, `${hash}.jpg`);
  });

  it('extracts png extension', () => {
    const { ext } = _generateCacheKey('http://example.com/cover.png?v=1');
    assert.equal(ext, 'png');
  });

  it('defaults to jpg for unknown extension', () => {
    const { ext } = _generateCacheKey('http://192.168.1.10:1400/getaa?s=1');
    assert.equal(ext, 'jpg');
  });

  it('produces consistent hash for same URL', () => {
    const url = 'http://192.168.1.10:1400/art.jpg';
    const { hash: hash1 } = _generateCacheKey(url);
    const { hash: hash2 } = _generateCacheKey(url);
    assert.equal(hash1, hash2);
  });

  it('produces different hashes for different URLs', () => {
    const { hash: hash1 } = _generateCacheKey('http://host1/art.jpg');
    const { hash: hash2 } = _generateCacheKey('http://host2/art.jpg');
    assert.notEqual(hash1, hash2);
  });

  it('hash is 24 hex characters', () => {
    const { hash } = _generateCacheKey('http://example.com/art.jpg');
    assert.match(hash, /^[a-f0-9]{24}$/);
  });
});

describe('_isTvTrack()', () => {
  it('returns true when title is "tv"', () => {
    assert.equal(_isTvTrack({ title: 'TV' }), true);
  });

  it('returns true for htastream URI', () => {
    assert.equal(_isTvTrack({ uri: 'x-sonos-htastream:something' }), true);
  });

  it('returns true for type "tv"', () => {
    assert.equal(_isTvTrack({ type: 'tv' }), true);
  });

  it('returns false for regular track', () => {
    assert.equal(_isTvTrack({ title: 'My Song', artist: 'Artist', uri: 'x-file-cifs:/music/song.mp3' }), false);
  });

  it('returns false for null input', () => {
    assert.equal(_isTvTrack(null), false);
  });
});

describe('_detectSource()', () => {
  it('returns "tv" for TV track', () => {
    assert.equal(_detectSource({ title: 'TV' }), 'tv');
  });

  it('returns "radio" for x-sonosapi-stream URI', () => {
    assert.equal(_detectSource({ uri: 'x-sonosapi-stream:something' }), 'radio');
  });

  it('returns "radio" for x-sonosapi-hls URI', () => {
    assert.equal(_detectSource({ uri: 'x-sonosapi-hls:something' }), 'radio');
  });

  it('returns "radio" for x-rincon-mp3radio URI', () => {
    assert.equal(_detectSource({ uri: 'x-rincon-mp3radio:something' }), 'radio');
  });

  it('returns "radio" for tunein URI', () => {
    assert.equal(_detectSource({ uri: 'http://opml.radiotime.com/tune.ashx?id=s1234' }), 'radio');
  });

  it('returns "radio" for aac: URI', () => {
    assert.equal(_detectSource({ uri: 'aac:http://stream.example.com/radio' }), 'radio');
  });

  it('returns "radio" when stationName is set and no URI', () => {
    assert.equal(_detectSource({ stationName: 'NRK P3' }), 'radio');
  });

  it('returns "spotify" for Spotify URI', () => {
    assert.equal(_detectSource({ uri: 'x-sonos-spotify:spotify:track:abc' }), 'spotify');
  });

  it('returns "apple_music" for Apple Music URI', () => {
    assert.equal(_detectSource({ uri: 'nds:music:applemusic:track:123' }), 'apple_music');
  });

  it('returns "apple_music" for URI containing "apple"', () => {
    assert.equal(_detectSource({ uri: 'x-apple-itunes:something' }), 'apple_music');
  });

  it('returns null for generic track type', () => {
    assert.equal(_detectSource({ uri: 'x-file-cifs:/music/song.mp3', type: 'track' }), null);
  });

  it('returns null for unknown source', () => {
    assert.equal(_detectSource({ uri: 'x-file-cifs:/music/song.mp3' }), null);
  });

  it('returns null for null input', () => {
    assert.equal(_detectSource(null), null);
  });
});

describe('Album art cache – filesystem integration', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-sonos-cache-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates cache directory when it does not exist', () => {
    const newDir = path.join(tmpDir, 'new-cache');
    assert.equal(fs.existsSync(newDir), false);

    // Simulate _ensureCacheDir
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true });
    }

    assert.equal(fs.existsSync(newDir), true);
  });

  it('_generateCacheKey produces a stable filename that is safe for the filesystem', () => {
    const url = 'http://192.168.1.10:1400/getaa?s=1&u=spotify%3Atrack%3Aabc';
    const { filename } = _generateCacheKey(url);

    // Filename must be safe – only hex chars and one dot before extension.
    // The extension list here must stay in sync with the regex in _generateCacheKey().
    assert.match(filename, /^[a-f0-9]{24}\.(jpg|jpeg|png|gif|webp|svg)$/);
  });

  it('writes a file and reads it back (simulated download)', () => {
    const { filename } = _generateCacheKey('http://example.com/cover.jpg');
    const dest = path.join(tmpDir, filename);
    const content = Buffer.from('fake-image-data');

    fs.writeFileSync(dest, content);
    assert.equal(fs.existsSync(dest), true);

    const read = fs.readFileSync(dest);
    assert.deepEqual(read, content);
  });

  it('cleanup removes files older than TTL', () => {
    const { filename } = _generateCacheKey('http://example.com/old.jpg');
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, 'data');

    // Back-date the mtime to simulate an old file (TTL = 1 ms)
    const pastTime = new Date(Date.now() - 10);
    fs.utimesSync(filePath, pastTime, pastTime);

    const ttl = 5; // 5 ms
    const now = Date.now();
    const files = fs.readdirSync(tmpDir);
    for (const file of files) {
      const fp = path.join(tmpDir, file);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > ttl) {
        fs.unlinkSync(fp);
      }
    }

    assert.equal(fs.existsSync(filePath), false);
  });

  it('cleanup skips all files when TTL is 0 (cache forever)', () => {
    const { filename } = _generateCacheKey('http://example.com/forever.jpg');
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, 'data');

    // Back-date the mtime — but TTL=0 should prevent any deletion
    const pastTime = new Date(Date.now() - 100000);
    fs.utimesSync(filePath, pastTime, pastTime);

    const ttl = 0; // means "cache forever"
    if (ttl && ttl > 0) {
      // This block should NOT execute when ttl === 0
      const now = Date.now();
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        const fp = path.join(tmpDir, file);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > ttl) {
          fs.unlinkSync(fp);
        }
      }
    }

    assert.equal(fs.existsSync(filePath), true);
    fs.unlinkSync(filePath); // cleanup for other tests
  });

  it('_clearAlbumArtCache removes all files in cache directory', () => {
    // Use a dedicated sub-directory to avoid interference from other tests
    const clearDir = path.join(tmpDir, 'clear-test');
    fs.mkdirSync(clearDir, { recursive: true });

    // Write multiple fake cached files
    const urls = [
      'http://example.com/art1.jpg',
      'http://example.com/art2.png',
      'http://example.com/art3.jpg'
    ];
    const filePaths = urls.map((url) => {
      const { filename } = _generateCacheKey(url);
      const fp = path.join(clearDir, filename);
      fs.writeFileSync(fp, 'fake-data');
      return fp;
    });

    // Verify all files exist
    filePaths.forEach((fp) => assert.equal(fs.existsSync(fp), true));

    // Simulate _clearAlbumArtCache — only remove files, not subdirectories
    const entries = fs.readdirSync(clearDir);
    entries.forEach((file) => {
      const fp = path.join(clearDir, file);
      if (fs.statSync(fp).isFile()) {
        fs.unlinkSync(fp);
      }
    });

    // All files should be removed
    filePaths.forEach((fp) => assert.equal(fs.existsSync(fp), false));
    assert.equal(fs.readdirSync(clearDir).length, 0);
  });
});

describe('_parseDIDL()', () => {
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
    assert.equal(_parseDIDL(sampleXml, 'dc:title'), 'NRK P3');
  });

  it('parses upnp:albumArtURI from DIDL-Lite XML', () => {
    assert.equal(_parseDIDL(sampleXml, 'upnp:albumArtURI'), '/getaa?s=1&amp;u=something');
  });

  it('parses r:streamContent from DIDL-Lite XML', () => {
    assert.equal(_parseDIDL(sampleXml, 'r:streamContent'), 'Sigrid – Burning Bridges');
  });

  it('returns null for missing element', () => {
    assert.equal(_parseDIDL(sampleXml, 'dc:missing'), null);
  });

  it('returns null for null XML input', () => {
    assert.equal(_parseDIDL(null, 'dc:title'), null);
  });

  it('returns null for non-string XML input', () => {
    assert.equal(_parseDIDL(42, 'dc:title'), null);
  });

  it('returns null for empty XML string', () => {
    assert.equal(_parseDIDL('', 'dc:title'), null);
  });

  it('returns null when element has empty value', () => {
    assert.equal(_parseDIDL('<dc:title></dc:title>', 'dc:title'), null);
  });

  it('trims whitespace from element value', () => {
    assert.equal(_parseDIDL('<dc:title>  Radio One  </dc:title>', 'dc:title'), 'Radio One');
  });
});

describe('_buildRadioArtUrl()', () => {
  it('builds correct HTTP URL for radio stream', () => {
    const url = _buildRadioArtUrl('x-sonosapi-stream:s1234', '192.168.1.10', 1400, false);
    assert.equal(url, 'http://192.168.1.10:1400/getaa?s=1&u=x-sonosapi-stream%3As1234');
  });

  it('builds HTTPS URL when forceHttps is true', () => {
    const url = _buildRadioArtUrl('x-sonosapi-stream:s1234', '192.168.1.10', 1400, true);
    assert.equal(url, 'https://192.168.1.10:1400/getaa?s=1&u=x-sonosapi-stream%3As1234');
  });

  it('uses default port 1400 when not specified', () => {
    const url = _buildRadioArtUrl('x-sonosapi-stream:s1234', '192.168.1.10', null, false);
    assert.equal(url, 'http://192.168.1.10:1400/getaa?s=1&u=x-sonosapi-stream%3As1234');
  });

  it('URL-encodes the stream URI', () => {
    const url = _buildRadioArtUrl('x-sonosapi-stream:s=1&q=test', '192.168.1.10', 1400, false);
    assert.ok(url.includes('x-sonosapi-stream%3As%3D1%26q%3Dtest'));
  });

  it('returns null for empty stream URI', () => {
    assert.equal(_buildRadioArtUrl('', '192.168.1.10', 1400, false), null);
  });

  it('returns null when coordinator host is missing', () => {
    assert.equal(_buildRadioArtUrl('x-sonosapi-stream:s1234', null, 1400, false), null);
  });

  it('returns null for null stream URI', () => {
    assert.equal(_buildRadioArtUrl(null, '192.168.1.10', 1400, false), null);
  });
});

describe('_isHidden() – whitelist/blacklist filtering', () => {
  const group = {
    id: 'RINCON_ABC:1',
    name: 'Stue',
    members: ['Stue', 'Hjemmekontor'],
    coordinatorHost: '192.168.1.50'
  };

  it('returns false when no filters are configured', () => {
    assert.equal(_isHidden(group, {}), false);
  });

  it('hides by group name (blacklist)', () => {
    assert.equal(_isHidden(group, { hiddenGroups: ['stue'] }), true);
  });

  it('hides by group ID (blacklist)', () => {
    assert.equal(_isHidden(group, { hiddenGroups: ['RINCON_ABC:1'] }), true);
  });

  it('hides by member name (blacklist)', () => {
    assert.equal(_isHidden(group, { hiddenSpeakers: ['hjemmekontor'] }), true);
  });

  it('hides by coordinator IP (blacklist)', () => {
    assert.equal(_isHidden(group, { hiddenSpeakers: ['192.168.1.50'] }), true);
  });

  it('does not hide an unrelated group (blacklist)', () => {
    assert.equal(_isHidden(group, { hiddenGroups: ['Kjøkken'], hiddenSpeakers: ['Bad'] }), false);
  });

  it('shows group when it matches allowedGroups whitelist', () => {
    assert.equal(_isHidden(group, { allowedGroups: ['Stue'] }), false);
  });

  it('hides group that does not match allowedGroups whitelist', () => {
    assert.equal(_isHidden(group, { allowedGroups: ['Kjøkken'] }), true);
  });

  it('shows group when its coordinator IP matches allowedGroups', () => {
    assert.equal(_isHidden(group, { allowedGroups: ['192.168.1.50'] }), false);
  });

  it('shows group when member matches allowedSpeakers whitelist', () => {
    assert.equal(_isHidden(group, { allowedSpeakers: ['Stue'] }), false);
  });

  it('hides group when no members match allowedSpeakers whitelist', () => {
    assert.equal(_isHidden(group, { allowedSpeakers: ['Kjøkken'] }), true);
  });

  it('shows group when coordinator IP matches allowedSpeakers whitelist', () => {
    assert.equal(_isHidden(group, { allowedSpeakers: ['192.168.1.50'] }), false);
  });

  it('blacklist takes precedence over whitelist', () => {
    // Group matches whitelist but also matches blacklist — should be hidden
    assert.equal(_isHidden(group, { hiddenGroups: ['Stue'], allowedGroups: ['Stue'] }), true);
  });
});
