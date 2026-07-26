import { describe, expect, test } from 'bun:test';
import { encodeShareDirectSync, unknownConfigKeys, KNOWN_CONFIG_KEYS } from '../src/config';

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

describe('shareTarget.directSync — stamped extension config (encodeShareDirectSync)', () => {
  test('absent / missing urlTemplate → empty token (feature inert)', () => {
    expect(encodeShareDirectSync(undefined)).toBe('');
    expect(encodeShareDirectSync({ urlTemplate: '' })).toBe('');
  });

  test('defaults applied: PUT, content/image fields, replace, 4MB cap, "Synced"', () => {
    const decoded = JSON.parse(Buffer.from(encodeShareDirectSync({ urlTemplate: 'https://api.example.com/x/{id}' }), 'base64').toString('utf8'));
    expect(decoded).toEqual({
      urlTemplate: 'https://api.example.com/x/{id}',
      method: 'PUT',
      fields: { text: 'content', image: 'image' },
      merge: 'replace',
      maxImageBytes: 4_000_000,
      maxImageEdge: 2000,
      jpegQuality: 0.85,
      successMessage: 'Synced',
    });
  });

  test('explicit values survive the round-trip (base64 is Swift-string-literal safe)', () => {
    const token = encodeShareDirectSync({
      urlTemplate: 'https://api.livx.cc/copy-bin/{binId}',
      merge: 'append',
      successMessage: 'Synced to {binId}',
      fields: { text: 'content' },
      maxImageBytes: 123,
    });
    expect(token).toMatch(/^[A-Za-z0-9+/=]+$/); // no quotes/backslashes — safe inside "…"
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    expect(decoded.merge).toBe('append');
    expect(decoded.maxImageBytes).toBe(123);
    expect(decoded.successMessage).toBe('Synced to {binId}');
    expect(decoded.fields).toEqual({ text: 'content', image: 'image' });
  });

  test('shareTarget is a recognized top-level config key', () => {
    expect(unknownConfigKeys({ shareTarget: { directSync: { urlTemplate: 'x' } } })).toEqual([]);
  });
});
