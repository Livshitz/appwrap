import { describe, expect, test } from 'bun:test';
import { MAX_AUTO_RETRIES, retryDelayMs } from '../app/shell/load-retry';

describe('retryDelayMs', () => {
  test('backs off 3 s → 30 s cap', () => {
    expect([0, 1, 2, 3, 4].map(retryDelayMs)).toEqual([3000, 6000, 12000, 24000, 30000]);
  });
  test('is bounded', () => {
    expect(retryDelayMs(MAX_AUTO_RETRIES - 1)).toBe(30000);
    expect(retryDelayMs(MAX_AUTO_RETRIES)).toBeNull();
  });
});
