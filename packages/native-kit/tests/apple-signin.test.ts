import { describe, expect, test } from 'bun:test';
import { NativeKit } from '../src/core/NativeKit';
import { isAppleSignInResult } from '../src/modules/appleSignIn';
import type { Handshake, NativeKitAdapter } from '../src/core/types';

const HS = (caps: Record<string, 'native' | 'none'>, platform: 'ios' | 'android' | 'web' = 'ios'): Handshake => ({
  protocol: 1,
  platform,
  app: { id: 'cc.livx.test', name: 'Test', version: '1.0.0' },
  capabilities: caps,
});

function adapter(
  caps: Record<string, 'native' | 'none'>,
  invoke?: NativeKitAdapter['invoke'],
  platform: 'ios' | 'android' | 'web' = 'ios'
): NativeKitAdapter {
  return {
    kind: 'appwrap',
    detect: () => true,
    handshake: async () => HS(caps, platform),
    invoke: invoke ?? (async <T,>() => undefined as T),
    on: () => () => {},
  };
}

describe('kit.appleSignIn', () => {
  test('native iOS: hands the raw nonce + scopes to the bridge, dismiss-bound, relays the result', async () => {
    const calls: Array<[string, unknown, unknown]> = [];
    const result = {
      identityToken: 'eyJhbGciOiJ.payload.sig',
      authorizationCode: 'code-123',
      nonce: 'raw-nonce-xyz',
      user: { name: { givenName: 'Ada', familyName: 'Lovelace', displayName: 'Ada Lovelace' }, email: 'ada@example.com' },
    };
    const kit = new NativeKit({
      adapters: [adapter({ appleSignIn: 'native' }, async <T,>(m: string, p?: unknown, o?: unknown) => {
        calls.push([m, p, o]);
        return result as T;
      })],
    });
    await kit.ready();
    expect(kit.appleSignIn.capability).toBe('native');

    const r = await kit.appleSignIn.signIn({ nonce: 'raw-nonce-xyz' });
    expect(isAppleSignInResult(r)).toBe(true);
    if (isAppleSignInResult(r)) {
      expect(r.identityToken).toBe(result.identityToken);
      expect(r.nonce).toBe('raw-nonce-xyz'); // RAW nonce returned for Firebase rawNonce
      expect(r.user?.email).toBe('ada@example.com');
    }
    // Exactly one bridge call, carrying the raw nonce + default scopes, dismiss-bound (no watchdog).
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('appleSignIn.signIn');
    expect(calls[0][1]).toEqual({ nonce: 'raw-nonce-xyz', scopes: ['name', 'email'] });
    expect(calls[0][2]).toEqual({ timeoutMs: 'none' });
  });

  test('passes explicit scopes through', async () => {
    const calls: Array<unknown> = [];
    const kit = new NativeKit({
      adapters: [adapter({ appleSignIn: 'native' }, async <T,>(_m: string, p?: unknown) => {
        calls.push(p);
        return { identityToken: 't', nonce: 'n' } as T;
      })],
    });
    await kit.ready();
    await kit.appleSignIn.signIn({ nonce: 'n', scopes: ['email'] });
    expect(calls[0]).toEqual({ nonce: 'n', scopes: ['email'] });
  });

  test('cancel resolves { cancelled: true } (never throws)', async () => {
    const kit = new NativeKit({
      adapters: [adapter({ appleSignIn: 'native' }, async <T,>() => ({ cancelled: true }) as T)],
    });
    await kit.ready();
    const r = await kit.appleSignIn.signIn({ nonce: 'n' });
    expect(isAppleSignInResult(r)).toBe(false);
    expect(r).toEqual({ cancelled: true });
  });

  test('empty nonce rejects without hitting the bridge', async () => {
    let invoked = false;
    const kit = new NativeKit({
      adapters: [adapter({ appleSignIn: 'native' }, async <T,>() => { invoked = true; return undefined as T; })],
    });
    await kit.ready();
    await expect(kit.appleSignIn.signIn({ nonce: '' })).rejects.toMatchObject({ code: 'NATIVE_ERROR' });
    expect(invoked).toBe(false);
  });

  test('honest gating off iOS (cap none): rejects UNSUPPORTED, never hits the bridge', async () => {
    let invoked = false;
    const kit = new NativeKit({
      adapters: [adapter({ appleSignIn: 'none' }, async <T,>() => { invoked = true; return undefined as T; }, 'android')],
    });
    await kit.ready();
    expect(kit.appleSignIn.capability).toBe('none');
    await expect(kit.appleSignIn.signIn({ nonce: 'n' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(invoked).toBe(false);
  });
});
