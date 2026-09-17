'use strict';

/**
 * Unit tests for the client-side favorites-list capping logic in MMM-Sonos.js.
 *
 * Inline copy of `_limitFavorites`, kept in sync with the real implementation,
 * to avoid pulling in the MagicMirror front-end runtime/DOM dependency in CI.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function _limitFavorites(favorites, maxFavorites) {
  const list = favorites || [];
  if (!maxFavorites || maxFavorites <= 0) return list;
  return list.slice(0, maxFavorites);
}

describe('_limitFavorites', () => {
  it('caps the list to maxFavorites items', () => {
    const favorites = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, title: `Favorite ${i}` }));

    const result = _limitFavorites(favorites, 12);

    assert.equal(result.length, 12);
    assert.deepEqual(result, favorites.slice(0, 12));
  });

  it('returns the full list unchanged when under the limit', () => {
    const favorites = [{ id: 'f0', title: 'Only one' }];

    const result = _limitFavorites(favorites, 12);

    assert.deepEqual(result, favorites);
  });

  it('treats 0 as no limit', () => {
    const favorites = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}` }));

    const result = _limitFavorites(favorites, 0);

    assert.equal(result.length, 20);
  });

  it('treats a missing/null maxFavorites as no limit', () => {
    const favorites = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}` }));

    assert.equal(_limitFavorites(favorites, null).length, 20);
    assert.equal(_limitFavorites(favorites, undefined).length, 20);
  });

  it('returns an empty array for an empty/undefined favorites list', () => {
    assert.deepEqual(_limitFavorites([], 12), []);
    assert.deepEqual(_limitFavorites(undefined, 12), []);
  });
});
