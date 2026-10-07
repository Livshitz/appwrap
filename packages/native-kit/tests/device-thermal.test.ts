import { describe, expect, test } from 'bun:test';
import { NativeKit } from '../src/core/NativeKit';
import type { Handshake, NativeKitAdapter } from '../src/core/types';
import type { ThermalState } from '../src/modules/device';
import { androidThermalState, iosThermalState } from '../../../runtime/app/shell/thermal-state';

const HS: Handshake = { protocol: 1, platform: 'ios', app: { id: 'cc.livx.test', name: 'Test', version: '1.0.0' }, capabilities: { device: 'native' } };

/** A shell adapter whose `device.thermal` read resolves when the test says so, with a hook to emit. */
function rig(current: ThermalState) {
  let fire: ((p: unknown) => void) | null = null;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const adapter: NativeKitAdapter = {
    kind: 'appwrap', detect: () => true, handshake: async () => HS,
    invoke: async <T,>(m: string) => { if (m !== 'device.thermal') throw new Error(m); await gate; return current as T; },
    on: (ev, cb) => { if (ev === 'device.thermal.change') fire = cb; return () => { fire = null; }; },
  };
  return { kit: new NativeKit({ adapters: [adapter] }), emit: (s: ThermalState) => fire?.({ state: s }), release, tick: () => new Promise((r) => setTimeout(r, 0)) };
}

describe('kit.device thermal', () => {
  test('onThermalChange delivers the current state on subscribe, then transitions', async () => {
    const r = rig('serious');
    await r.kit.ready();
    const seen: ThermalState[] = [];
    r.kit.device.onThermalChange((s) => seen.push(s));
    r.release(); await r.tick();
    r.emit('nominal');
    expect(seen).toEqual(['serious', 'nominal']);
  });

  test('a transition that lands before the initial read wins (no stale overwrite)', async () => {
    const r = rig('critical');
    await r.kit.ready();
    const seen: ThermalState[] = [];
    r.kit.device.onThermalChange((s) => seen.push(s));
    r.emit('fair');
    r.release(); await r.tick();
    expect(seen).toEqual(['fair']);
  });

  test('unsubscribe before the initial read resolves delivers nothing', async () => {
    const r = rig('critical');
    await r.kit.ready();
    const seen: ThermalState[] = [];
    r.kit.device.onThermalChange((s) => seen.push(s))();
    r.release(); await r.tick();
    r.emit('serious');
    expect(seen).toEqual([]);
  });
});

describe('native thermal mapping', () => {
  test('iOS NSProcessInfoThermalState 0..3', () => {
    expect([0, 1, 2, 3, 9].map(iosThermalState)).toEqual(['nominal', 'fair', 'serious', 'critical', 'nominal']);
  });
  test('Android THERMAL_STATUS_* 0..6', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(androidThermalState)).toEqual(['nominal', 'fair', 'fair', 'serious', 'critical', 'critical', 'critical']);
  });
});
