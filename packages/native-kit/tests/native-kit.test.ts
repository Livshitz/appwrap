import { afterEach, describe, expect, test } from 'bun:test';
import { NativeKit } from '../src/core/NativeKit';
import { AppwrapAdapter } from '../src/core/appwrap-adapter';
import { KitError, type Handshake, type NativeKitAdapter, type RequestEnvelope } from '../src/core/types';
import { HttpValidator } from '../src/modules/billing/validators';
import { HttpBillingProvider } from '../src/modules/billing/providers';

const HS: Handshake = {
  protocol: 1,
  platform: 'ios',
  app: { id: 'cc.livx.test', name: 'Test', version: '1.0.0' },
  capabilities: { haptics: 'native', share: 'native' },
};

function fakeAdapter(overrides?: Partial<NativeKitAdapter>): NativeKitAdapter {
  return {
    kind: 'appwrap',
    detect: () => true,
    handshake: async () => HS,
    invoke: async <T,>() => undefined as T,
    on: () => () => {},
    ...overrides,
  };
}

describe('NativeKit core', () => {
  test('picks first detecting adapter and exposes handshake', async () => {
    const kit = new NativeKit({
      adapters: [fakeAdapter({ detect: () => false }), fakeAdapter()],
    });
    const hs = await kit.ready();
    expect(hs.platform).toBe('ios');
    expect(kit.is.native).toBe(true);
    expect(kit.capability('haptics')).toBe('native');
    expect(kit.capability('unknown')).toBe('none');
  });

  test('module calls route through adapter.invoke with namespaced methods', async () => {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({ invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return undefined as T; } })],
    });
    await kit.ready();
    await kit.haptics.impact('light');
    await kit.toast.show('hi', 'long');
    expect(calls).toEqual([
      ['haptics.impact', { style: 'light' }],
      ['toast.show', { message: 'hi', duration: 'long' }],
    ]);
  });

  test('ready() rejects when nothing detects', async () => {
    const kit = new NativeKit({ adapters: [fakeAdapter({ detect: () => false })] });
    await expect(kit.ready()).rejects.toThrow(KitError);
  });

  test('ready() rejects on a protocol-mismatched (stale) shell', async () => {
    const kit = new NativeKit({
      adapters: [fakeAdapter({ handshake: async () => ({ ...HS, protocol: 2 as any }) })],
    });
    await expect(kit.ready()).rejects.toThrow(/protocol/i);
  });
});

describe('Billing — swappable validator seam', () => {
  const NATIVE_ENTS = [{ productId: 'pro_monthly', active: true }];

  function billingKit() {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [
        fakeAdapter({
          handshake: async () => ({ ...HS, capabilities: { billing: 'native' } }),
          invoke: async <T,>(m: string, p?: unknown) => {
            calls.push([m, p]);
            if (m === 'billing.purchase') return { platform: 'ios', productId: (p as any).productId, appReceipt: 'rcpt', raw: {} } as T;
            if (m === 'billing.restore') return [{ platform: 'ios', productId: 'pro_monthly', raw: {} }] as T;
            if (m === 'billing.entitlements') return NATIVE_ENTS as T;
            return undefined as T;
          },
        }),
      ],
    });
    return { kit, calls };
  }

  test('default ClientTrustedValidator grants the product WITHOUT a device read (no restore prompt)', async () => {
    const { kit, calls } = billingKit();
    await kit.ready();
    const res = await kit.billing.purchase('pro_monthly');
    // purchase must NOT trigger billing.entitlements (a StoreKit-1 restore = Apple ID prompt)
    expect(calls.map((c) => c[0])).toEqual(['billing.purchase']);
    expect(res.receipt.appReceipt).toBe('rcpt');
    expect(res.entitlements[0]).toMatchObject({ productId: 'pro_monthly', active: true });
    // entitlements() is the explicit query that reads the device
    expect(await kit.billing.entitlements()).toEqual(NATIVE_ENTS);
    expect(calls.some((c) => c[0] === 'billing.entitlements')).toBe(true);
  });

  test('configure() swaps in a custom validator; native purchase still runs', async () => {
    const { kit, calls } = billingKit();
    await kit.ready();
    const seen: string[] = [];
    kit.billing.configure({
      validator: {
        validate: async (r) => { seen.push(r.productId); return [{ productId: r.productId, active: true, expiresAt: 999 }]; },
        entitlements: async () => [{ productId: 'srv', active: true }],
      },
    });
    const res = await kit.billing.purchase('pro_monthly');
    expect(seen).toEqual(['pro_monthly']);          // custom validator was consulted
    expect(res.entitlements[0].expiresAt).toBe(999); // server truth, not device
    expect(calls.some((c) => c[0] === 'billing.entitlements')).toBe(false); // device read skipped
    expect(await kit.billing.entitlements()).toEqual([{ productId: 'srv', active: true }]);
  });

  test('HttpValidator POSTs the receipt and maps the response', async () => {
    const reqs: Array<{ url: string; body: any }> = [];
    const fakeFetch = (async (url: string, init: any) => {
      reqs.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ entitlements: [{ productId: 'pro', active: true }] }) };
    }) as unknown as typeof fetch;
    const v = new HttpValidator({ validateUrl: 'https://api.example/validate', fetch: fakeFetch });
    const ents = await v.validate({ platform: 'ios', productId: 'pro', jws: 'J', raw: {} });
    expect(reqs[0].url).toBe('https://api.example/validate');
    expect(reqs[0].body.jws).toBe('J');
    expect(ents).toEqual([{ productId: 'pro', active: true }]);
  });
});

describe('Billing — same API, web provider (Stripe et al.)', () => {
  // A web-context kit: adapter.kind 'web' so kit.is.web is true and billing routes to the provider.
  function webKit() {
    const nativeCalls: string[] = [];
    const kit = new NativeKit({
      adapters: [
        fakeAdapter({
          kind: 'web',
          handshake: async () => ({ ...HS, platform: 'web', capabilities: { billing: 'none' } }),
          invoke: async <T,>(m: string) => { nativeCalls.push(m); return undefined as T; },
        }),
      ],
    });
    return { kit, nativeCalls };
  }

  const WEB_PROVIDER = () => {
    const seen: string[] = [];
    const provider = {
      seen,
      products: async (ids: string[]) => ids.map((id) => ({ id, title: id, description: '', price: 5, displayPrice: '$5', currency: 'USD', type: 'autoRenewable' as const })),
      purchase: async (id: string) => { seen.push(`buy:${id}`); return [{ productId: id, active: true }]; },
      entitlements: async () => { seen.push('ents'); return [{ productId: 'pro', active: true }]; },
      manageSubscriptions: async () => { seen.push('portal'); },
    };
    return provider;
  };

  test('capability is "none" on web until a provider is configured, then "web"', async () => {
    const { kit } = webKit();
    await kit.ready();
    expect(kit.billing.capability).toBe('none');
    kit.billing.configure({ webProvider: WEB_PROVIDER() });
    expect(kit.billing.capability).toBe('web');
  });

  test('on web with NO provider, methods throw an actionable error (never hit the native bridge)', async () => {
    const { kit, nativeCalls } = webKit();
    await kit.ready();
    await expect(kit.billing.purchase('pro')).rejects.toThrow(/configure.*webProvider/i);
    await expect(kit.billing.products(['pro'])).rejects.toThrow(/webProvider/);
    await expect(kit.billing.entitlements()).rejects.toThrow(/webProvider/);
    expect(nativeCalls.filter((m) => m.startsWith('billing.'))).toEqual([]); // bridge never touched on web
  });

  test('the SAME kit.billing.* calls route to the web provider, never the native bridge', async () => {
    const { kit, nativeCalls } = webKit();
    await kit.ready();
    const provider = WEB_PROVIDER();
    kit.billing.configure({ webProvider: provider });

    const products = await kit.billing.products(['pro']);
    expect(products[0].displayPrice).toBe('$5');
    const res = await kit.billing.purchase('pro');
    expect(res.receipt.platform).toBe('web');
    expect(res.entitlements).toEqual([{ productId: 'pro', active: true }]);
    expect(await kit.billing.entitlements()).toEqual([{ productId: 'pro', active: true }]);
    await kit.billing.manageSubscriptions();

    expect(provider.seen).toEqual(['buy:pro', 'ents', 'portal']);
    expect(nativeCalls.filter((m) => m.startsWith('billing.'))).toEqual([]); // bridge untouched
  });

  test('HttpBillingProvider: inline entitlements resolve; a checkout url redirects', async () => {
    const redirects: string[] = [];
    const inlineFetch = (async () => ({ ok: true, json: async () => ({ entitlements: [{ productId: 'pro', active: true }] }) })) as unknown as typeof fetch;
    const inline = new HttpBillingProvider({ baseUrl: 'https://api.example/billing', fetch: inlineFetch, redirect: (u) => redirects.push(u) });
    expect(await inline.purchase('pro')).toEqual([{ productId: 'pro', active: true }]);
    expect(redirects).toEqual([]); // inline → no redirect

    const urlFetch = (async () => ({ ok: true, json: async () => ({ url: 'https://checkout.stripe/x' }) })) as unknown as typeof fetch;
    const hosted = new HttpBillingProvider({ baseUrl: 'https://api.example/billing', fetch: urlFetch, redirect: (u) => redirects.push(u) });
    expect(await hosted.purchase('pro')).toEqual([]); // navigates away; entitlements come on return
    expect(redirects).toEqual(['https://checkout.stripe/x']);
  });
});

describe('AppwrapAdapter wire protocol', () => {
  function wired() {
    const posted: RequestEnvelope[] = [];
    (globalThis as any).window = {
      webkit: { messageHandlers: { appwrap: { postMessage: (json: string) => posted.push(JSON.parse(json)) } } },
    };
    const adapter = new AppwrapAdapter();
    return { adapter, posted, win: (globalThis as any).window };
  }

  test('request/response correlation by id', async () => {
    const { adapter, posted, win } = wired();
    const p = adapter.handshake(1000);
    expect(posted[0].method).toBe('app.handshake');
    win.__appwrapDeliver(JSON.stringify({ v: 1, id: posted[0].id, kind: 'response', result: HS }));
    expect((await p).app.id).toBe('cc.livx.test');
    delete (globalThis as any).window;
  });

  test('native error becomes KitError with code', async () => {
    const { adapter, posted, win } = wired();
    adapter.handshake(1000).catch(() => {}); // installs deliver
    const p = adapter.invoke('share.share', {});
    const req = posted.find((m) => m.method === 'share.share')!;
    win.__appwrapDeliver(JSON.stringify({
      v: 1, id: req.id, kind: 'response', error: { code: 'DENIED', message: 'nope' },
    }));
    await expect(p).rejects.toMatchObject({ code: 'DENIED', name: 'KitError' });
    delete (globalThis as any).window;
  });

  test('events fan out to subscribers', async () => {
    const { adapter, posted, win } = wired();
    adapter.handshake(1000).catch(() => {});
    const got: unknown[] = [];
    const off = adapter.on('deeplink.open', (p) => got.push(p));
    win.__appwrapDeliver(JSON.stringify({ v: 1, kind: 'event', event: 'deeplink.open', payload: { url: 'x://y' } }));
    expect(got).toEqual([{ url: 'x://y' }]);
    off();
    win.__appwrapDeliver(JSON.stringify({ v: 1, kind: 'event', event: 'deeplink.open', payload: {} }));
    expect(got.length).toBe(1);
    delete (globalThis as any).window;
    expect(posted.length).toBeGreaterThan(0);
  });
});

describe('parity modules (W1–W9 surface)', () => {
  test('new modules route namespaced methods', async () => {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({ invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return undefined as T; } })],
    });
    await kit.ready();
    await kit.ui.alert({ message: 'hi' });
    await kit.ui.confirm({ message: 'sure?' });
    await kit.ui.action({ options: ['a', 'b'] });
    await kit.ui.setBackgroundColor('#112233');
    await kit.reviews.requestReview();
    await kit.storage.clear();
    await kit.contacts.pick();
    await kit.calendar.createEvent({ title: 'T' });
    await kit.photos.capture();
    expect(calls.map(([m]) => m)).toEqual([
      'ui.alert', 'ui.confirm', 'ui.action', 'ui.setBackgroundColor',
      'reviews.requestReview', 'storage.clear', 'contacts.pick',
      'calendar.createEvent', 'camera.capture',
    ]);
  });

  test('geo.watch subscribes, starts, and stop unsubscribes + stops', async () => {
    const calls: string[] = [];
    let listener: ((p: unknown) => void) | null = null;
    let offCalled = false;
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        invoke: async <T,>(m: string) => { calls.push(m); return undefined as T; },
        on: (_e, cb) => { listener = cb; return () => { offCalled = true; }; },
      })],
    });
    await kit.ready();
    const positions: unknown[] = [];
    const stop = await kit.geo.watch((p) => positions.push(p));
    expect(calls).toEqual(['geo.watch.start']);
    listener!({ lat: 1, lng: 2 });
    expect(positions).toEqual([{ lat: 1, lng: 2 }]);
    stop();
    await Bun.sleep(0);
    expect(offCalled).toBe(true);
    expect(calls).toEqual(['geo.watch.start', 'geo.watch.stop']);
  });

  test('motion.watch propagates start failure and detaches the listener', async () => {
    let offCalled = false;
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        invoke: async () => { throw new KitError('UNSUPPORTED', 'no sensors'); },
        on: () => () => { offCalled = true; },
      })],
    });
    await kit.ready();
    await expect(kit.motion.watch(() => {})).rejects.toThrow('no sensors');
    expect(offCalled).toBe(true);
  });
});

describe('share.files + screen.orientation', () => {
  test('share.files and orientation lock/unlock/current route namespaced methods', async () => {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { shareFiles: 'native', orientation: 'native' } }),
        invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return undefined as T; },
      })],
    });
    await kit.ready();
    expect(kit.share.filesCapability).toBe('native');
    expect(kit.screen.orientation.capability).toBe('native');
    await kit.share.files([{ name: 'a.txt', mimeType: 'text/plain', base64: 'aGk=' }], { text: 'see' });
    await kit.screen.orientation.lock('landscape');
    await kit.screen.orientation.unlock();
    await kit.screen.orientation.current();
    expect(calls).toEqual([
      ['share.files', { files: [{ name: 'a.txt', mimeType: 'text/plain', base64: 'aGk=' }], text: 'see' }],
      ['screen.orientation.lock', { orientation: 'landscape' }],
      ['screen.orientation.unlock', undefined],
      ['screen.orientation.current', undefined],
    ]);
  });

  test('orientation.onChange forwards the bare orientation payload', async () => {
    let listener: ((p: unknown) => void) | null = null;
    const kit = new NativeKit({
      adapters: [fakeAdapter({ on: (_e, cb) => { listener = cb; return () => {}; } })],
    });
    await kit.ready();
    const seen: string[] = [];
    kit.screen.orientation.onChange((o) => seen.push(o));
    listener!('landscape');
    listener!('portrait');
    expect(seen).toEqual(['landscape', 'portrait']);
  });
});

describe('Updates — remote-update detection (anti-phantom invariant)', () => {
  function updatesKit() {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({ invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return undefined as T; } })],
    });
    return { kit, calls };
  }
  const okFetch = (body: any) => ((async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch);
  const throwFetch = (() => { throw new Error('offline'); }) as unknown as typeof fetch;

  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  // Drives ONE explicit check() in isolation (start()'s own auto-check is drained + discarded first),
  // returning the deterministic status + the invokes that the explicit check made.
  async function checkOnce(opts: { current: string; fetch: typeof fetch; autoPrompt?: boolean }) {
    const { kit, calls } = updatesKit();
    await kit.ready();
    globalThis.fetch = opts.fetch;
    kit.updates.start({ currentVersion: opts.current, manifestUrl: 'http://x/version.json', pollIntervalMs: 0, autoPrompt: opts.autoPrompt ?? false });
    await Bun.sleep(5);     // drain start()'s fire-and-forget auto-check
    calls.length = 0;       // isolate the explicit check below
    const status = await kit.updates.check();
    kit.updates.stop();
    return { status, calls };
  }

  test('updateAvailable is true ONLY when both versions are known AND differ', async () => {
    expect((await checkOnce({ current: '1.0.0', fetch: okFetch({ version: '1.1.0' }) })).status.updateAvailable).toBe(true);
    expect((await checkOnce({ current: '1.0.0', fetch: okFetch({ version: '1.0.0' }) })).status.updateAvailable).toBe(false);
    // unknown current (embedded __APP_VERSION__ absent) → never a phantom prompt, even if manifest differs
    expect((await checkOnce({ current: '', fetch: okFetch({ version: '1.1.0' }) })).status.updateAvailable).toBe(false);
  });

  test('a failed manifest fetch reports latest="" and no update (offline is not "behind")', async () => {
    const { status } = await checkOnce({ current: '1.0.0', fetch: throwFetch });
    expect(status).toMatchObject({ current: '1.0.0', latest: '', updateAvailable: false });
  });

  test('every check reports the version status to native (App-Info screen), incl. the build id', async () => {
    const { status, calls } = await checkOnce({ current: '1.0.0', fetch: okFetch({ version: '1.1.0', build: 42 }) });
    expect(status.build).toBe(42);
    expect(calls.find(([m]) => m === 'app.reportWebVersion')?.[1]).toMatchObject({ current: '1.0.0', latest: '1.1.0', build: 42, updateAvailable: true });
  });

  test('autoPrompt shows the native banner on an update; equal versions never prompt', async () => {
    const up = updatesKit(); await up.kit.ready();
    globalThis.fetch = okFetch({ version: '1.1.0' });
    up.kit.updates.start({ currentVersion: '1.0.0', manifestUrl: 'http://x/version.json', pollIntervalMs: 0, autoPrompt: true });
    await Bun.sleep(5); up.kit.updates.stop();
    expect(up.calls.find(([m]) => m === 'toast.banner')?.[1]).toMatchObject({ id: 'appwrap.update' });

    const same = updatesKit(); await same.kit.ready();
    globalThis.fetch = okFetch({ version: '1.0.0' });
    same.kit.updates.start({ currentVersion: '1.0.0', manifestUrl: 'http://x/version.json', pollIntervalMs: 0, autoPrompt: true });
    await Bun.sleep(5); same.kit.updates.stop();
    expect(same.calls.some(([m]) => m === 'toast.banner')).toBe(false);
  });

  test('the banner is shown at most once per session (no nagging on every poll)', async () => {
    const { kit, calls } = updatesKit();
    await kit.ready();
    globalThis.fetch = okFetch({ version: '1.1.0' });
    kit.updates.start({ currentVersion: '1.0.0', manifestUrl: 'http://x/version.json', pollIntervalMs: 0, autoPrompt: true });
    await Bun.sleep(5);
    await kit.updates.check();   // poll again — still behind
    await kit.updates.check();
    kit.updates.stop();
    expect(calls.filter(([m]) => m === 'toast.banner').length).toBe(1);
  });
});

describe('Push — provider-agnostic token + receipt seam', () => {
  test('register() returns the raw {platform, token}; the kit never sends', async () => {
    const calls: string[] = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { push: 'native' } }),
        invoke: async <T,>(m: string) => {
          calls.push(m);
          if (m === 'push.requestPermission') return 'granted' as T;
          if (m === 'push.register') return { platform: 'apns', token: 'deadbeef' } as T;
          return undefined as T;
        },
      })],
    });
    await kit.ready();
    expect(kit.push.capability).toBe('native');
    expect(await kit.push.requestPermission()).toBe('granted');
    expect(await kit.push.register()).toEqual({ platform: 'apns', token: 'deadbeef' });
    expect(calls).toEqual(['push.requestPermission', 'push.register']);
  });

  test('onMessage / onTap forward the parsed payload', async () => {
    let listener: ((e: string, p: unknown) => void) | null = null;
    const handlers = new Map<string, (p: unknown) => void>();
    const kit = new NativeKit({
      adapters: [fakeAdapter({ on: (e, cb) => { handlers.set(e, cb); return () => {}; } })],
    });
    await kit.ready();
    const msgs: unknown[] = [];
    const taps: unknown[] = [];
    kit.push.onMessage((m) => msgs.push(m));
    kit.push.onTap((m) => taps.push(m));
    handlers.get('push.message')!({ data: { id: '7' }, title: 'Hi' });
    handlers.get('push.tap')!({ data: { id: '9' } });
    expect(msgs).toEqual([{ data: { id: '7' }, title: 'Hi' }]);
    expect(taps).toEqual([{ data: { id: '9' } }]);
    void listener;
  });

  test('web push throws an actionable error (no native push in a browser)', async () => {
    // handshake()/detect() need a DOM; test the adapter's invoke directly (no window in bun).
    const { WebAdapter } = await import('../src/core/web-adapter');
    const web = new WebAdapter();
    await expect(web.invoke('push.register')).rejects.toThrow(/web push|VAPID|shell/i);
    await expect(web.invoke('push.requestPermission')).rejects.toThrow(/web push|VAPID|shell/i);
  });
});
