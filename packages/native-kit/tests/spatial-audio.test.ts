import { test, expect } from 'bun:test';
import { MediaModule } from '../src/modules/media';
import { HeadphoneMotionModule } from '../src/modules/headphoneMotion';
import { NativeKit } from '../src/core/NativeKit';

/** Fake kit: per-capability map, records invokes, lets the test fire bridge events. */
function fakeKit(caps: Record<string, string>) {
  const calls: Array<[string, unknown]> = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const kit = {
    ready: async () => ({}),
    capability: (k: string) => caps[k] ?? 'none',
    on: (ev: string, cb: (p: unknown) => void) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return () => listeners.get(ev)!.delete(cb);
    },
    invoke: async (m: string, p?: unknown) => {
      calls.push([m, p]);
      if (m === 'audio.route') return { type: 'builtInSpeaker', headphones: false };
      if (m === 'headphoneMotion.start' && caps.__startThrows) throw Object.assign(new Error('x'), { code: 'NOT_CONFIGURED' });
    },
  };
  const fire = (ev: string, p: unknown) => listeners.get(ev)?.forEach((cb) => cb(p));
  return { kit: kit as any, calls, fire, listenerCount: (ev: string) => listeners.get(ev)?.size ?? 0 };
}

test('configureAudio reaches the shell via audioSession alone (no camera/mic `media` module needed)', async () => {
  const f = fakeKit({ audioSession: 'native', media: 'none' });
  await new MediaModule(f.kit).configureAudio('playback', { mixWithOthers: false });
  expect(f.calls).toEqual([['media.configureAudio', { mode: 'playback', mixWithOthers: false }]]);
});

test('configureAudio is a no-op on web / Android (neither capability native)', async () => {
  const f = fakeKit({ audioSession: 'none', media: 'web' });
  await new MediaModule(f.kit).configureAudio('playback');
  expect(f.calls).toEqual([]);
});

test('route() asks the shell only where the session exists', async () => {
  expect(await new MediaModule(fakeKit({ audioSession: 'none' }).kit).route()).toBeNull();
  const f = fakeKit({ audioSession: 'native' });
  expect(await new MediaModule(f.kit).route()).toEqual({ type: 'builtInSpeaker', headphones: false } as any);
});

test('interruption + routeChange events reach subscribers and unsubscribe cleanly', () => {
  const f = fakeKit({ audioSession: 'native' });
  const media = new MediaModule(f.kit);
  const got: unknown[] = [];
  const offI = media.onInterruption((e) => got.push(e));
  const offR = media.onRouteChange((e) => got.push(e.reason));
  f.fire('audio.interruption', { type: 'ended', shouldResume: true });
  f.fire('audio.routeChange', { reason: 'oldDeviceUnavailable' });
  offI(); offR();
  f.fire('audio.interruption', { type: 'began' });
  expect(got).toEqual([{ type: 'ended', shouldResume: true }, 'oldDeviceUnavailable']);
});

test('headphoneMotion.availability is null where the capability is absent', async () => {
  const f = fakeKit({ headphoneMotion: 'none' });
  expect(await new HeadphoneMotionModule(f.kit).availability()).toBeNull();
  expect(f.calls).toEqual([]);
});

test('headphoneMotion.watch starts at the asked hz, streams samples, stops once', async () => {
  const f = fakeKit({ headphoneMotion: 'native' });
  const hm = new HeadphoneMotionModule(f.kit);
  const samples: number[] = [];
  const stop = await hm.watch((s) => samples.push(s.yaw), { hz: 30 });
  f.fire('headphoneMotion.data', { yaw: 0.5 });
  stop(); stop();
  f.fire('headphoneMotion.data', { yaw: 0.9 });
  expect(samples).toEqual([0.5]);
  expect(f.calls.map((c) => c[0])).toEqual(['headphoneMotion.start', 'headphoneMotion.stop']);
  expect(f.calls[0][1]).toEqual({ hz: 30 });
});

test('a failed headphoneMotion.start leaves no dangling listener', async () => {
  const f = fakeKit({ headphoneMotion: 'native', __startThrows: '1' });
  await expect(new HeadphoneMotionModule(f.kit).watch(() => {})).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  expect(f.listenerCount('headphoneMotion.data')).toBe(0);
});

test('the real NativeKit constructs and keeps headphoneMotion off the web fallback', () => {
  // Constructing the real kit is the check: a module touching NativeKit's private fields from its own
  // constructor threw here (field init order) and killed the page on the simulator.
  const kit = new NativeKit();
  expect(kit.headphoneMotion).toBeInstanceOf(HeadphoneMotionModule);
  expect((kit as any).webFallbackExcludedDomains.has('headphoneMotion.')).toBe(true);
});
