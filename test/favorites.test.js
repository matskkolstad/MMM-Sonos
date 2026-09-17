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

// Pure copy of the new `_resolveFavoriteState()` helper from MMM-Sonos.js — decides
// whether a favorites-list row should render as active, pending (tapped, awaiting
// confirmation), or idle.
function _resolveFavoriteState(favorite, groupTitle, pendingFavoriteId) {
  if (groupTitle && favorite.title === groupTitle) return 'active';
  if (favorite.id === pendingFavoriteId) return 'pending';
  return 'idle';
}

describe('_resolveFavoriteState', () => {
  const favorite = { id: 'fav-1', title: 'Morning Jazz' };

  it('returns "active" when the group is currently playing this favorite', () => {
    assert.equal(_resolveFavoriteState(favorite, 'Morning Jazz', null), 'active');
  });

  it('returns "pending" when this favorite was just tapped and is not yet confirmed active', () => {
    assert.equal(_resolveFavoriteState(favorite, 'Something Else', 'fav-1'), 'pending');
  });

  it('prefers "active" over "pending" once the group title actually matches', () => {
    // Simulates the tick where confirmation lands: the tapped favorite is still
    // recorded as pending, but the group title now matches it too.
    assert.equal(_resolveFavoriteState(favorite, 'Morning Jazz', 'fav-1'), 'active');
  });

  it('returns "idle" when neither active nor pending', () => {
    assert.equal(_resolveFavoriteState(favorite, 'Something Else', null), 'idle');
    assert.equal(_resolveFavoriteState(favorite, 'Something Else', 'fav-2'), 'idle');
  });

  it('returns "idle" when there is no current group title', () => {
    assert.equal(_resolveFavoriteState(favorite, null, null), 'idle');
  });
});
