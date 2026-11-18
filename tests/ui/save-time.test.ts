import { describe, expect, it } from 'vitest';
import { formatSaveTime } from '../../src/ui/goals/save-time';

const acknowledgement = Date.UTC(2026, 10, 18, 21, 7);

describe('formats the same UTC acknowledgement in two device time zones', () => {
  it.each([
    ['Europe/Moscow', '00:07'],
    ['America/Los_Angeles', '13:07'],
  ])('formats the UTC instant in %s as %s', (timeZone, expected) => {
    expect(formatSaveTime(acknowledgement, timeZone)).toBe(expected);
  });
});
