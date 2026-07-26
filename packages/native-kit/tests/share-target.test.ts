import { describe, expect, test } from 'bun:test';
import { NativeKit } from '../src/core/NativeKit';
import { parseSharePayload } from '../src/modules/shareTarget';
import type { Handshake, NativeKitAdapter } from '../src/core/types';

const HS = (caps: Record<string, 'native' | 'none'>, deepLink?: string): Handshake => ({
  protocol: 1,
  platform: 'android',
  app: { id: 'cc.livx.test', name: 'Test', version: '1.0.0' },
  capabilities: caps,
  ...(deepLink ? { deepLink } : {}),
});

/** Adapter that captures event listeners so a test can emit warm events. */
function adapter(caps: Record<string, 'native' | 'none'>, deepLink?: string) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const a: NativeKitAdapter = {
    kind: 'appwrap',
    detect: () => true,
    handshake: async () => HS(caps, deepLink),
    invoke: async <T,>() => undefined as T,
    on: (event: string, cb: (payload: unknown) => void) => {
      listeners.set(event, cb);
      return () => listeners.delete(event);
    },
  };
  return { a, emit: (event: string, payload: unknown) => listeners.get(event)?.(payload) };
}

describe('parseSharePayload', () => {
  test('parses text + title + repeated files from a share deep link', () => {
    const p = parseSharePayload('copybin://share?text=hello%20world&title=Note&file=appwrap-share%2Fa.png&file=appwrap-share%2Fb.jpg');
    expect(p).toEqual({ text: 'hello world', title: 'Note', files: ['appwrap-share/a.png', 'appwrap-share/b.jpg'] });
  });

  test('null for non-share URLs, empty shares, and garbage', () => {
    expect(parseSharePayload('copybin://send?text=x')).toBeNull(); // different host — the Shortcut legacy path is NOT a share delivery
    expect(parseSharePayload('https://share?text=x')).toBeNull(); // http(s) is never a share delivery
    expect(parseSharePayload('copybin://share')).toBeNull(); // no payload
    expect(parseSharePayload(null)).toBeNull();
    expect(parseSharePayload('not a url')).toBeNull();
  });
});

describe('kit.shareTarget', () => {
  test('capability comes from the handshake map', async () => {
    const { a } = adapter({ shareTarget: 'native' });
    const kit = new NativeKit({ adapters: [a] });
    await kit.ready();
    expect(kit.shareTarget.capability).toBe('native');
  });

  test('cold start: replays the launch share once, to the first subscriber only', async () => {
    const { a } = adapter({ shareTarget: 'native' }, 'copybin://share?text=cold%20text');
    const kit = new NativeKit({ adapters: [a] });
    await kit.ready();
    const got: unknown[] = [];
    kit.shareTarget.onReceive((p) => got.push(p));
    await Bun.sleep(0); // replay is delivered on the ready() microtask
    expect(got).toEqual([{ text: 'cold text' }]);
    const second: unknown[] = [];
    kit.shareTarget.onReceive((p) => second.push(p));
    await Bun.sleep(0);
    expect(second).toEqual([]); // read-once
  });

  test('warm share: deeplink.open share URLs are parsed and delivered; others ignored', async () => {
    const { a, emit } = adapter({ shareTarget: 'native' });
    const kit = new NativeKit({ adapters: [a] });
    await kit.ready();
    const got: unknown[] = [];
    kit.shareTarget.onReceive((p) => got.push(p));
    emit('deeplink.open', { url: 'copybin://share?text=warm&file=appwrap-share%2Fpic.png' });
    emit('deeplink.open', { url: 'copybin://open/route' }); // ordinary deep link — not a share
    expect(got).toEqual([{ text: 'warm', files: ['appwrap-share/pic.png'] }]);
  });
});

describe('kit.shareTarget.setContext', () => {
  test('publishes the KV over the bridge as shareTarget.setContext', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { a } = adapter({ shareTarget: 'native' });
    a.invoke = async <T,>(method: string, params?: unknown) => { calls.push({ method, params }); return undefined as T; };
    const kit = new NativeKit({ adapters: [a] });
    await kit.ready();
    await kit.shareTarget.setContext({ binId: 'abc123', n: 7 });
    await kit.shareTarget.setContext(null); // clear
    expect(calls).toEqual([
      { method: 'shareTarget.setContext', params: { context: { binId: 'abc123', n: 7 } } },
      { method: 'shareTarget.setContext', params: { context: null } },
    ]);
  });
});
