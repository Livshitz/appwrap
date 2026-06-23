import { describe, expect, test } from 'bun:test';
import { NativeKit } from '../src/core/NativeKit';
import type { Handshake, NativeKitAdapter } from '../src/core/types';

const HS = (caps: Record<string, 'native' | 'none'>): Handshake => ({
  protocol: 1,
  platform: 'ios',
  app: { id: 'cc.livx.test', name: 'Test', version: '1.0.0' },
  capabilities: caps,
});

function adapter(caps: Record<string, 'native' | 'none'>, invoke?: NativeKitAdapter['invoke']): NativeKitAdapter {
  return {
    kind: 'appwrap',
    detect: () => true,
    handshake: async () => HS(caps),
    invoke: invoke ?? (async <T,>() => undefined as T),
    on: () => () => {},
  };
}

describe('kit.tracking capability gating', () => {
  test('native iOS: routes through the bridge with dismiss-bound request', async () => {
    const calls: Array<[string, unknown, unknown]> = [];
    const kit = new NativeKit({
      adapters: [adapter({ tracking: 'native' }, async <T,>(m: string, p?: unknown, o?: unknown) => {
        calls.push([m, p, o]);
        return (m === 'tracking.requestPermission' ? 'authorized' : m === 'tracking.status' ? 'denied' : 'AD-IDFA-1') as T;
      })],
    });
    await kit.ready();
    expect(kit.tracking.capability).toBe('native');
    expect(await kit.tracking.requestPermission()).toBe('authorized');
    expect(await kit.tracking.status()).toBe('denied');
    expect(await kit.tracking.permissionStatus()).toBe('denied');
    expect(await kit.tracking.idfa()).toBe('AD-IDFA-1');
    expect(calls.map((c) => c[0])).toEqual([
      'tracking.requestPermission', 'tracking.status', 'tracking.status', 'tracking.idfa',
    ]);
    // requestPermission must be dismiss-bound (no watchdog) — same convention as oauth/billing sheet.
    expect(calls[0][2]).toEqual({ timeoutMs: 'none' });
  });

  test('honest fallback (Android/web/iOS<14.5: cap none): never hits the bridge', async () => {
    let invoked = false;
    const kit = new NativeKit({
      adapters: [adapter({ tracking: 'none' }, async <T,>() => { invoked = true; return undefined as T; })],
    });
    await kit.ready();
    expect(kit.tracking.capability).toBe('none');
    // No OS gate exists → tracking is not blocked → report 'authorized', not a misleading notDetermined.
    expect(await kit.tracking.requestPermission()).toBe('authorized');
    expect(await kit.tracking.status()).toBe('authorized');
    // No IDFA off iOS.
    expect(await kit.tracking.idfa()).toBeUndefined();
    expect(invoked).toBe(false);
  });
});
