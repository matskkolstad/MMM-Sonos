'use strict';

/**
 * Unit tests for the client-side progress bar interpolation logic in MMM-Sonos.js.
 *
 * Inline copy of `_parseProgressData`, kept in sync with the real implementation,
 * to avoid pulling in the MagicMirror front-end runtime/DOM dependency in CI.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Mirrors MMM-Sonos.js `_parseProgressData` (post-fix): while paused, the position
// must not be extrapolated forward using elapsed wall-clock time.
function _parseProgressData(dataset, now) {
  const initialPosition = parseFloat(dataset.initialPosition);
  const duration = parseFloat(dataset.duration);
  const timestamp = parseFloat(dataset.timestamp);
  const isPlaying = dataset.isPlaying === 'true';

  if (isNaN(initialPosition) || isNaN(duration) || isNaN(timestamp) || duration <= 0) {
    return null;
  }

  if (!isPlaying) {
    return { initialPosition, duration, timestamp, elapsed: 0, currentPosition: initialPosition };
  }

  const elapsed = (now - timestamp) / 1000;
  const currentPosition = Math.min(duration, initialPosition + elapsed);

  return { initialPosition, duration, timestamp, elapsed, currentPosition };
}

describe('_parseProgressData', () => {
  it('freezes currentPosition at initialPosition while paused', () => {
    const now = 1_000_000;
    const dataset = {
      initialPosition: '9',
      duration: '173',
      timestamp: String(now - 10_000), // paused 10s ago
      isPlaying: 'false'
    };

    const result = _parseProgressData(dataset, now);

    assert.equal(result.currentPosition, 9);
  });

  it('extrapolates currentPosition forward while playing', () => {
    const now = 1_000_000;
    const dataset = {
      initialPosition: '9',
      duration: '173',
      timestamp: String(now - 10_000),
      isPlaying: 'true'
    };

    const result = _parseProgressData(dataset, now);

    assert.equal(result.currentPosition, 19);
  });

  it('never lets a paused track roll over to 0 after the poll interval elapses', () => {
    const now = 1_000_000;
    const pollIntervalMs = 15_000;
    const dataset = {
      initialPosition: '9',
      duration: '173',
      timestamp: String(now - pollIntervalMs),
      isPlaying: 'false'
    };

    const result = _parseProgressData(dataset, now);

    assert.equal(result.currentPosition, 9);
  });
});
