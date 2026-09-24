'use strict';

/**
 * Unit tests for the touch-control helpers in node_helper.js (enableControls).
 * Uses the real node_helper.js via test/helpers/load-module.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadNodeHelper } = require('./helpers/load-module');

const helper = loadNodeHelper();

describe('_resolveMemberHost()', () => {
  it('parses host and port from a Location URL', () => {
    const result = helper._resolveMemberHost({ Location: 'http://192.168.1.50:1400/xml/device_description.xml' });
    assert.deepEqual(result, { host: '192.168.1.50', port: 1400 });
  });

  it('defaults to port 1400 when the URL has no explicit port', () => {
    const result = helper._resolveMemberHost({ Location: 'http://192.168.1.50/xml/device_description.xml' });
    assert.deepEqual(result, { host: '192.168.1.50', port: 1400 });
  });

  it('returns null when there is no Location field', () => {
    assert.equal(helper._resolveMemberHost({ ZoneName: 'Kitchen' }), null);
  });

  it('returns null for a malformed Location URL', () => {
    assert.equal(helper._resolveMemberHost({ Location: 'not-a-url' }), null);
  });

  it('accepts a lowercase location field', () => {
    const result = helper._resolveMemberHost({ location: 'http://10.0.0.17:1400/xml/device_description.xml' });
    assert.deepEqual(result, { host: '10.0.0.17', port: 1400 });
  });
});


describe('_mapFavorites()', () => {
  it('maps title/uri/id fields', () => {
    const result = helper._mapFavorites([{ id: 'FV:2/0', title: 'NRK P3', uri: 'x-sonosapi-hls:p3' }]);
    assert.deepEqual(result, [{ id: 'FV:2/0', title: 'NRK P3', uri: 'x-sonosapi-hls:p3' }]);
  });

  it('drops favorites with no uri', () => {
    const result = helper._mapFavorites([{ id: 'a', title: 'Broken favorite' }]);
    assert.deepEqual(result, []);
  });

  it('falls back to an index-based id when missing', () => {
    const result = helper._mapFavorites([{ title: 'NRK P1', uri: 'x-sonosapi-hls:p1' }]);
    assert.equal(result[0].id, 'favorite-0');
  });

  it('falls back to "Untitled" when title is missing', () => {
    const result = helper._mapFavorites([{ uri: 'x-sonosapi-hls:p1' }]);
    assert.equal(result[0].title, 'Untitled');
  });

  it('returns an empty array for empty/undefined input', () => {
    assert.deepEqual(helper._mapFavorites([]), []);
    assert.deepEqual(helper._mapFavorites(undefined), []);
  });
});


describe('_findZone()', () => {
  const findZone = (lastPayload, zoneId) => {
    const helper = loadNodeHelper();
    helper.lastPayload = lastPayload;
    return helper._findZone(zoneId);
  };
  const payload = [
    { id: 'zone-1', name: 'Kitchen' },
    { id: 'zone-2', name: 'Bedroom' }
  ];

  it('finds a zone by id', () => {
    assert.deepEqual(findZone(payload, 'zone-2'), { id: 'zone-2', name: 'Bedroom' });
  });

  it('returns null when the zone id is not found', () => {
    assert.equal(findZone(payload, 'zone-99'), null);
  });

  it('returns null for an empty payload', () => {
    assert.equal(findZone([], 'zone-1'), null);
    assert.equal(findZone(undefined, 'zone-1'), null);
  });
});


describe('_buildMemberDetails()', () => {
  it('pairs each member name with its resolved host', () => {
    const result = helper._buildMemberDetails(
      [
        { roomName: 'Living Room', Location: 'http://192.168.1.10:1400/xml/device_description.xml' },
        { roomName: 'Kitchen', Location: 'http://192.168.1.11:1400/xml/device_description.xml' }
      ],
      new Set()
    );
    assert.deepEqual(result.members, ['Living Room', 'Kitchen']);
    assert.deepEqual(result.memberDetails, [
      { name: 'Living Room', host: '192.168.1.10', port: 1400 },
      { name: 'Kitchen', host: '192.168.1.11', port: 1400 }
    ]);
    assert.equal(result.skipGroup, false);
  });

  it('keeps members and memberDetails paired when a host cannot be resolved', () => {
    // Regression test: the old code pushed to two separate arrays independently,
    // so a member with an unresolvable host would desync memberDetails from members.
    const result = helper._buildMemberDetails(
      [
        { roomName: 'Living Room', Location: 'not-a-url' },
        { roomName: 'Kitchen', Location: 'http://192.168.1.11:1400/xml/device_description.xml' }
      ],
      new Set()
    );
    assert.deepEqual(result.members, ['Living Room', 'Kitchen']);
    assert.equal(result.memberDetails.length, 2);
    assert.equal(result.memberDetails[0].name, 'Living Room');
    assert.equal(result.memberDetails[0].host, null);
    assert.equal(result.memberDetails[1].name, 'Kitchen');
    assert.equal(result.memberDetails[1].host, '192.168.1.11');
  });

  it('skips members with no resolvable display name', () => {
    const result = helper._buildMemberDetails([{ Location: 'http://192.168.1.10:1400/x' }], new Set());
    assert.deepEqual(result.members, []);
    assert.deepEqual(result.memberDetails, []);
  });

  it('marks skipGroup and stops once a hidden speaker is found', () => {
    const result = helper._buildMemberDetails(
      [
        { roomName: 'Living Room', Location: 'http://192.168.1.10:1400/x' },
        { roomName: 'Bathroom', Location: 'http://192.168.1.12:1400/x' },
        { roomName: 'Kitchen', Location: 'http://192.168.1.11:1400/x' }
      ],
      new Set(['bathroom'])
    );
    assert.equal(result.skipGroup, true);
    assert.deepEqual(result.members, ['Living Room']);
  });
});


describe('_resolveMemberTarget()', () => {
  const zone = {
    memberDetails: [
      { name: 'Living Room', host: '192.168.1.10', port: 1400 },
      { name: 'Kitchen', host: '192.168.1.11', port: 1400 },
      { name: 'Unreachable', host: null, port: null }
    ]
  };

  it('returns host/port for a matching member name', () => {
    assert.deepEqual(helper._resolveMemberTarget(zone, 'Kitchen'), { host: '192.168.1.11', port: 1400 });
  });

  it('matches case-insensitively', () => {
    assert.deepEqual(helper._resolveMemberTarget(zone, 'kitchen'), { host: '192.168.1.11', port: 1400 });
  });

  it('returns null when the name is not found', () => {
    assert.equal(helper._resolveMemberTarget(zone, 'Bathroom'), null);
  });

  it('returns null when the matched member has no host', () => {
    assert.equal(helper._resolveMemberTarget(zone, 'Unreachable'), null);
  });

  it('returns null for a missing zone or member name', () => {
    assert.equal(helper._resolveMemberTarget(null, 'Kitchen'), null);
    assert.equal(helper._resolveMemberTarget(zone, null), null);
  });
});


describe('_resolveLeaveGroupTarget()', () => {
  const multiMemberZone = {
    memberDetails: [
      { name: 'Living Room', host: '192.168.1.10', port: 1400 },
      { name: 'Kitchen', host: '192.168.1.11', port: 1400 }
    ]
  };
  const singleMemberZone = {
    memberDetails: [{ name: 'Living Room', host: '192.168.1.10', port: 1400 }]
  };

  it('returns host/port for a valid member in a multi-member zone', () => {
    assert.deepEqual(helper._resolveLeaveGroupTarget(multiMemberZone, 'Kitchen'), { host: '192.168.1.11', port: 1400 });
  });

  it('returns an error when the zone has only one speaker', () => {
    const result = helper._resolveLeaveGroupTarget(singleMemberZone, 'Living Room');
    assert.equal(result.host, undefined);
    assert.match(result.error, /only one speaker/i);
  });

  it('returns an error when the member name is not found in the zone', () => {
    const result = helper._resolveLeaveGroupTarget(multiMemberZone, 'Bathroom');
    assert.match(result.error, /not found/i);
  });
});


describe('_resolveJoinGroupPlan()', () => {
  const zone = { id: 'zone-1', members: ['Living Room', 'Kitchen'] };
  const targetZone = {
    id: 'zone-2',
    members: ['Patio', 'Garage'],
    memberDetails: [
      { name: 'Patio', host: '192.168.1.20', port: 1400 },
      { name: 'Garage', host: '192.168.1.21', port: 1400 }
    ]
  };

  it('returns the anchor room and every reachable target member for a valid join', () => {
    assert.deepEqual(helper._resolveJoinGroupPlan(zone, targetZone), {
      anchorRoomName: 'Living Room',
      targetMembers: [
        { name: 'Patio', host: '192.168.1.20', port: 1400 },
        { name: 'Garage', host: '192.168.1.21', port: 1400 }
      ]
    });
  });

  it('omits target members with no resolvable host', () => {
    const partiallyUnreachable = {
      id: 'zone-2',
      members: ['Patio', 'Garage'],
      memberDetails: [
        { name: 'Patio', host: '192.168.1.20', port: 1400 },
        { name: 'Garage', host: null, port: null }
      ]
    };
    const result = helper._resolveJoinGroupPlan(zone, partiallyUnreachable);
    assert.deepEqual(result.targetMembers, [{ name: 'Patio', host: '192.168.1.20', port: 1400 }]);
  });

  it('returns an error when the current zone has no members', () => {
    const result = helper._resolveJoinGroupPlan({ id: 'zone-1', members: [] }, targetZone);
    assert.match(result.error, /zone not found/i);
  });

  it('returns an error when the target zone is missing', () => {
    const result = helper._resolveJoinGroupPlan(zone, null);
    assert.match(result.error, /target zone not found/i);
  });

  it('returns an error when the target zone is the same as the current zone', () => {
    const result = helper._resolveJoinGroupPlan(zone, { id: 'zone-1', members: ['Kitchen'] });
    assert.match(result.error, /already/i);
  });

  it('returns an error when the target zone has no reachable speakers', () => {
    const result = helper._resolveJoinGroupPlan(zone, { id: 'zone-2', members: ['Patio'], memberDetails: [] });
    assert.match(result.error, /no reachable speakers/i);
  });
});
