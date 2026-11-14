import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateLabel, dayOffset } from '../apps/customer/lib/pickup-days.ts';

const losAngeles = 'America/Los_Angeles';

test('pickup date labels advance over the spring DST jump by local calendar days', () => {
  const now = new Date('2026-03-08T07:30:00Z');
  assert.equal(dateLabel(0, losAngeles, now), 'Saturday, March 7');
  assert.equal(dateLabel(1, losAngeles, now), 'Sunday, March 8');
  assert.equal(dateLabel(2, losAngeles, now), 'Monday, March 9');
  assert.equal(dayOffset('2026-03-09T17:00:00Z', losAngeles, now), 2);
});

test('pickup date labels advance over the fall DST repeat by local calendar days', () => {
  const now = new Date('2026-11-01T06:30:00Z');
  assert.equal(dateLabel(0, losAngeles, now), 'Saturday, October 31');
  assert.equal(dateLabel(1, losAngeles, now), 'Sunday, November 1');
  assert.equal(dayOffset('2026-11-02T05:30:00Z', losAngeles, now), 1);
});

test('the same slot can fall on different local dates', () => {
  const now = new Date('2026-11-13T23:30:00Z');
  const slot = '2026-11-14T03:30:00Z';
  assert.equal(dayOffset(slot, losAngeles, now), 0);
  assert.equal(dayOffset(slot, 'Europe/London', now), 1);
});
