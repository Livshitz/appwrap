import { describe, expect, test } from 'bun:test';
import { unknownConfigKeys, KNOWN_CONFIG_KEYS } from '../src/config';

describe('unknownConfigKeys — guards against silently-ignored config keys', () => {
  test('a valid config produces no warnings', () => {
    const cfg = { id: 'x', name: 'y', version: '1.0.0', pwaDist: 'dist', loader: 'server', serverUrl: 'https://a.b', targetedDevices: 'iphone', push: {}, permissions: {} };
    expect(unknownConfigKeys(cfg)).toEqual([]);
  });

  test('flags a typo and an unknown key', () => {
    // `targetedDevice` (missing the s) is exactly the silent-no-op class this guards.
    expect(unknownConfigKeys({ id: 'x', targetedDevice: 'iphone', madeUpKey: 1 })).toEqual(['targetedDevice', 'madeUpKey']);
  });

  test('KNOWN_CONFIG_KEYS covers the load-bearing options', () => {
    for (const k of ['targetedDevices', 'loader', 'serverUrl', 'push', 'permissions', 'modules', 'version', 'buildNumber']) {
      expect(KNOWN_CONFIG_KEYS.has(k)).toBe(true);
    }
  });

  test('nested push sub-keys are NOT top-level keys (must be inside push)', () => {
    expect(KNOWN_CONFIG_KEYS.has('apsEnvironment')).toBe(false);
    expect(KNOWN_CONFIG_KEYS.has('registrationUrl')).toBe(false);
  });
});
