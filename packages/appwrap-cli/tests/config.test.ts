import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  // THE RATCHET. Since 0.61.5 an unregistered key FAILS the build, so forgetting to add a new
  // `AppwrapConfig` field here breaks every config that uses it. Before that it was worse and
  // quieter: `iosInfoPlist` shipped registered but UNIMPLEMENTED in the published CLI, and Blank's
  // Live Activities were refused on the phone while the build, signing and upload all went green.
  // Read the interface off the source so the two cannot drift.
  test('every AppwrapConfig field is registered in KNOWN_CONFIG_KEYS', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/config.ts'), 'utf8');
    const body = src.slice(src.indexOf('export interface AppwrapConfig'));
    const fields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}([a-zA-Z_][\w]*)\??:/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(40); // the parse itself must not silently match nothing
    expect(fields.filter((f) => !KNOWN_CONFIG_KEYS.has(f))).toEqual([]);
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
