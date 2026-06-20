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

describe('Keyboard', () => {
  test('hide() routes to keyboard.hide; onShow/onHide forward the payload', async () => {
    const calls: string[] = [];
    const handlers = new Map<string, (p: unknown) => void>();
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { keyboard: 'native' } }),
        invoke: async <T,>(m: string) => { calls.push(m); return undefined as T; },
        on: (e, cb) => { handlers.set(e, cb); return () => {}; },
      })],
    });
    await kit.ready();
    expect(kit.keyboard.capability).toBe('native');

    await kit.keyboard.hide();
    expect(calls).toEqual(['keyboard.hide']);

    const shows: unknown[] = [];
    let hidden = 0;
    kit.keyboard.onShow((e) => shows.push(e));
    kit.keyboard.onHide(() => hidden++);
    handlers.get('keyboard.show')!({ height: 291 });
    handlers.get('keyboard.hide')!(undefined);
    expect(shows).toEqual([{ height: 291 }]);
    expect(hidden).toBe(1);
  });

  test('web keyboard.hide blurs the focused element', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    let blurred = false;
    (globalThis as any).document = { activeElement: { blur: () => { blurred = true; } } };
    try {
      await new WebAdapter().invoke('keyboard.hide');
      expect(blurred).toBe(true);
    } finally {
      delete (globalThis as any).document;
    }
  });

  test('web VisualViewport heuristic: fires show(height) once, then hide — no double-fire, ignores sub-threshold', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    const handlers = new Set<() => void>(); // real addEventListener stacks listeners — one per subscription
    const fire = () => handlers.forEach((h) => h());
    const vv = {
      height: 800,
      offsetTop: 0,
      addEventListener: (_e: string, cb: () => void) => { handlers.add(cb); },
      removeEventListener: (_e: string, cb: () => void) => { handlers.delete(cb); },
    };
    (globalThis as any).window = { innerHeight: 800, visualViewport: vv };
    try {
      const web = new WebAdapter();
      const shows: Array<{ height: number }> = [];
      let hides = 0;
      web.on('keyboard.show', (p) => shows.push(p as { height: number }));
      web.on('keyboard.hide', () => hides++);

      vv.height = 750; fire();              // 50px < 120 threshold → toolbar, NOT keyboard
      expect(shows.length).toBe(0);

      vv.height = 500; fire();              // 300px hidden → keyboard up
      vv.height = 480; fire();              // still up — must NOT re-fire show
      expect(shows).toEqual([{ height: 300 }]);
      expect(hides).toBe(0);

      vv.height = 800; fire();              // dismissed
      expect(hides).toBe(1);
    } finally {
      delete (globalThis as any).window;
    }
  });
});

describe('Fs', () => {
  test('module methods route to namespaced fs.* with path + options merged in', async () => {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { fs: 'native' } }),
        invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return ({ uri: 'file:///x' } as unknown) as T; },
      })],
    });
    await kit.ready();
    expect(kit.fs.capability).toBe('native');

    await kit.fs.write('a/b.txt', 'hi', { dir: 'cache', recursive: true });
    await kit.fs.read('a/b.txt', { dir: 'cache', encoding: 'base64' });
    await kit.fs.list('a', { dir: 'documents' });
    await kit.fs.pickFile({ types: ['application/pdf'], multiple: true });
    expect(calls).toEqual([
      ['fs.write', { path: 'a/b.txt', data: 'hi', dir: 'cache', recursive: true }],
      ['fs.read', { path: 'a/b.txt', dir: 'cache', encoding: 'base64' }],
      ['fs.list', { path: 'a', dir: 'documents' }],
      ['fs.pickFile', { types: ['application/pdf'], multiple: true }],
    ]);
  });

  test('web OPFS round-trips write → read → list → stat; getUri is honestly UNSUPPORTED', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    const { KitError } = await import('../src/core/types');

    // Minimal in-memory OPFS: a dir handle holding nested dir/file handles.
    const makeFile = (bytes: Uint8Array) => {
      const h: any = {
        kind: 'file',
        _bytes: bytes,
        getFile: async () => ({
          size: h._bytes.length,
          lastModified: 123,
          text: async () => new TextDecoder().decode(h._bytes),
          arrayBuffer: async () => h._bytes.buffer,
        }),
        createWritable: async ({ keepExistingData }: any = {}) => ({
          _buf: keepExistingData ? Array.from(h._bytes as Uint8Array) : [],
          seek() {},
          async write(chunk: any) {
            const u8 = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
            for (const b of u8) (this._buf as number[]).push(b);
          },
          async close() { h._bytes = Uint8Array.from(this._buf as number[]); },
        }),
      };
      return h;
    };
    const makeDir = (): any => {
      const dirs = new Map<string, any>();
      const files = new Map<string, any>();
      return {
        kind: 'directory',
        async getDirectoryHandle(name: string, { create }: any = {}) {
          if (!dirs.has(name)) { if (!create) throw new Error('NotFound'); dirs.set(name, makeDir()); }
          return dirs.get(name);
        },
        async getFileHandle(name: string, { create }: any = {}) {
          if (!files.has(name)) { if (!create) throw new Error('NotFound'); files.set(name, makeFile(new Uint8Array())); }
          return files.get(name);
        },
        async removeEntry(name: string) { files.delete(name); dirs.delete(name); },
        async *entries() { for (const [n, h] of files) yield [n, h]; for (const [n, h] of dirs) yield [n, h]; },
      };
    };
    const root = makeDir();
    (globalThis as any).navigator = { storage: { getDirectory: async () => root } };
    (globalThis as any).window = {};
    (globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
    (globalThis as any).atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
    try {
      const web = new WebAdapter();
      await web.invoke('fs.write', { path: 'demo/note.txt', data: 'hello', recursive: true });
      expect(await web.invoke('fs.read', { path: 'demo/note.txt' })).toBe('hello');

      const list = await web.invoke<Array<{ name: string; type: string }>>('fs.list', { path: 'demo' });
      expect(list).toEqual([{ name: 'note.txt', type: 'file' }]);

      const st = await web.invoke<{ type: string; size: number }>('fs.stat', { path: 'demo/note.txt' });
      expect(st.type).toBe('file');
      expect(st.size).toBe(5);

      await expect(web.invoke('fs.getUri', { path: 'demo/note.txt' })).rejects.toBeInstanceOf(KitError);
    } finally {
      delete (globalThis as any).navigator;
      delete (globalThis as any).window;
    }
  });

  test('web OPFS rejects `..` path traversal across read/write/list/mkdir', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    const { KitError } = await import('../src/core/types');
    (globalThis as any).navigator = { storage: { getDirectory: async () => ({}) } };
    (globalThis as any).window = {};
    try {
      const web = new WebAdapter();
      const evil = '../../etc/passwd';
      await expect(web.invoke('fs.read', { path: evil })).rejects.toBeInstanceOf(KitError);
      await expect(web.invoke('fs.write', { path: evil, data: 'x' })).rejects.toBeInstanceOf(KitError);
      await expect(web.invoke('fs.list', { path: '../escape' })).rejects.toBeInstanceOf(KitError);
      await expect(web.invoke('fs.mkdir', { path: 'a/../../b' })).rejects.toBeInstanceOf(KitError);
    } finally {
      delete (globalThis as any).navigator;
      delete (globalThis as any).window;
    }
  });

  test('web pickFile reads chosen files into base64 via a hidden <input type=file>', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    let input: any;
    const fakeFile = {
      name: 'doc.pdf',
      type: 'application/pdf',
      size: 3,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
    (globalThis as any).document = {
      createElement: () => (input = { type: '', files: [fakeFile], click() { queueMicrotask(() => this.onchange()); } }),
    };
    (globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
    try {
      const out = await new WebAdapter().invoke<any[]>('fs.pickFile', { types: ['application/pdf'] });
      expect(input.accept).toBe('application/pdf');
      expect(out).toEqual([{ name: 'doc.pdf', mimeType: 'application/pdf', size: 3, base64: btoa('\x01\x02\x03') }]);
    } finally {
      delete (globalThis as any).document;
    }
  });
});

describe('Scanner', () => {
  test('scan/cancel route to namespaced scanner.* with options merged in', async () => {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { scanner: 'native' } }),
        invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return ({ value: 'X', format: 'qr' } as unknown) as T; },
      })],
    });
    await kit.ready();
    expect(kit.scanner.capability).toBe('native');

    await kit.scanner.scan({ formats: ['qr', 'ean13'], camera: 'front' });
    await kit.scanner.scan();
    await kit.scanner.cancel();
    expect(calls).toEqual([
      ['scanner.scan', { formats: ['qr', 'ean13'], camera: 'front' }],
      ['scanner.scan', {}],
      ['scanner.cancel', undefined],
    ]);
  });

  test('isScanResult discriminates the result vs cancelled shapes', async () => {
    const { isScanResult } = await import('../src/modules/scanner');
    expect(isScanResult({ value: 'abc', format: 'qr' })).toBe(true);
    expect(isScanResult({ cancelled: true })).toBe(false);
  });

  test('web: capability is "web" only when BOTH BarcodeDetector and getUserMedia exist', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    const baseNav = { mediaDevices: { getUserMedia: async () => ({}) } };

    // Both present → 'web'
    (globalThis as any).window = { BarcodeDetector: class {} };
    (globalThis as any).navigator = baseNav;
    (globalThis as any).screen = {};
    (globalThis as any).location = { hostname: 'x' };
    (globalThis as any).document = { title: 't' };
    try {
      expect((await new WebAdapter().handshake()).capabilities.scanner).toBe('web');

      // Detector present but NO camera → 'none'
      (globalThis as any).navigator = {};
      expect((await new WebAdapter().handshake()).capabilities.scanner).toBe('none');

      // Camera present but NO detector → 'none'
      (globalThis as any).window = {};
      (globalThis as any).navigator = baseNav;
      expect((await new WebAdapter().handshake()).capabilities.scanner).toBe('none');
    } finally {
      for (const k of ['window', 'navigator', 'screen', 'location', 'document']) delete (globalThis as any)[k];
    }
  });

  test('web: scanner.scan throws UNSUPPORTED when BarcodeDetector is absent (no JS-decoder fallback)', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    (globalThis as any).window = {}; // no BarcodeDetector
    (globalThis as any).navigator = { mediaDevices: { getUserMedia: async () => ({}) } };
    try {
      await expect(new WebAdapter().invoke('scanner.scan', {})).rejects.toBeInstanceOf(KitError);
    } finally {
      delete (globalThis as any).window;
      delete (globalThis as any).navigator;
    }
  });

  test('web: scanner.scan decodes the first BarcodeDetector hit and tears the camera down', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    const stopped: string[] = [];
    const stream = { getTracks: () => [{ stop: () => stopped.push('video') }] };
    let detectCalls = 0;
    class FakeDetector {
      constructor(public opts?: any) {}
      async detect() {
        detectCalls++;
        return detectCalls >= 2 ? [{ rawValue: 'WIFI:demo', format: 'qr_code', boundingBox: { x: 1, y: 2, width: 3, height: 4 } }] : [];
      }
    }
    const removed: any[] = [];
    (globalThis as any).window = { BarcodeDetector: FakeDetector };
    (globalThis as any).navigator = { mediaDevices: { getUserMedia: async () => stream } };
    (globalThis as any).requestAnimationFrame = (cb: any) => { Promise.resolve().then(() => cb()); return 1; };
    (globalThis as any).cancelAnimationFrame = () => {};
    (globalThis as any).document = {
      body: { appendChild() {} },
      createElement: () => ({
        style: {}, setAttribute() {}, appendChild() {}, play: async () => {},
        set srcObject(_v: any) {}, remove() { removed.push(1); },
        setTitleForState() {},
      }),
    };
    try {
      const out: any = await new WebAdapter().invoke('scanner.scan', { formats: 'qr' });
      expect(out).toEqual({ value: 'WIFI:demo', format: 'qr', bounds: { x: 1, y: 2, width: 3, height: 4 } });
      expect(stopped).toContain('video'); // camera released
      expect(removed.length).toBeGreaterThan(0); // overlay removed
    } finally {
      for (const k of ['window', 'navigator', 'document', 'requestAnimationFrame', 'cancelAnimationFrame']) delete (globalThis as any)[k];
    }
  });
});

describe('Speech', () => {
  test('TTS + STT calls route to namespaced speech.* with options merged in', async () => {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { speech: 'native', speechRecognition: 'native' } }),
        invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return (m === 'speech.listen' ? 'hello world' : []) as unknown as T; },
      })],
    });
    await kit.ready();
    expect(kit.speech.capability).toBe('native');
    expect(kit.speech.recognitionCapability).toBe('native');

    await kit.speech.speak('hi there', { lang: 'en-US', rate: 1.2 });
    await kit.speech.stop();
    await kit.speech.voices();
    const transcript = await kit.speech.listen({ lang: 'en-US', partial: true });
    await kit.speech.stopListening();

    expect(transcript).toBe('hello world');
    expect(calls).toEqual([
      ['speech.speak', { text: 'hi there', lang: 'en-US', rate: 1.2 }],
      ['speech.stop', undefined],
      ['speech.voices', undefined],
      ['speech.listen', { lang: 'en-US', partial: true }],
      ['speech.stopListening', undefined],
    ]);
  });

  test('onPartial forwards the interim transcript payload', async () => {
    const handlers = new Map<string, (p: unknown) => void>();
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { speech: 'native', speechRecognition: 'native' } }),
        on: (e, cb) => { handlers.set(e, cb); return () => {}; },
      })],
    });
    await kit.ready();
    const partials: string[] = [];
    kit.speech.onPartial((p) => partials.push(p.transcript));
    handlers.get('speech.partial')!({ transcript: 'hel' });
    handlers.get('speech.partial')!({ transcript: 'hello' });
    expect(partials).toEqual(['hel', 'hello']);
  });

  test('web: TTS cap gates on speechSynthesis, STT cap gates on SpeechRecognition presence', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    (globalThis as any).navigator = {};
    (globalThis as any).screen = {};
    (globalThis as any).location = { hostname: 'x' };
    (globalThis as any).document = { title: 't' };
    try {
      // Both present
      (globalThis as any).window = { speechSynthesis: {}, webkitSpeechRecognition: class {} };
      let caps = (await new WebAdapter().handshake()).capabilities;
      expect(caps.speech).toBe('web');
      expect(caps.speechRecognition).toBe('web');

      // TTS only (Safari/Firefox — no SpeechRecognition)
      (globalThis as any).window = { speechSynthesis: {} };
      caps = (await new WebAdapter().handshake()).capabilities;
      expect(caps.speech).toBe('web');
      expect(caps.speechRecognition).toBe('none');

      // Neither
      (globalThis as any).window = {};
      caps = (await new WebAdapter().handshake()).capabilities;
      expect(caps.speech).toBe('none');
      expect(caps.speechRecognition).toBe('none');
    } finally {
      for (const k of ['window', 'navigator', 'screen', 'location', 'document']) delete (globalThis as any)[k];
    }
  });

  test('web: speech.listen throws UNSUPPORTED when SpeechRecognition is absent (honest)', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    (globalThis as any).window = {}; // no SpeechRecognition
    try {
      await expect(new WebAdapter().invoke('speech.listen', {})).rejects.toBeInstanceOf(KitError);
    } finally {
      delete (globalThis as any).window;
    }
  });

  test('web: speak resolves on utterance end and applies lang/rate', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    const spoken: any[] = [];
    class FakeUtterance {
      lang = ''; rate = 1; pitch = 1; voice: any = null;
      onend: any = null; onerror: any = null;
      constructor(public text: string) {}
    }
    (globalThis as any).window = {
      SpeechSynthesisUtterance: FakeUtterance,
      speechSynthesis: {
        getVoices: () => [],
        speak: (u: any) => { spoken.push(u); Promise.resolve().then(() => u.onend?.()); },
      },
    };
    try {
      await new WebAdapter().invoke('speech.speak', { text: 'hi', lang: 'en-GB', rate: 1.5 });
      expect(spoken.length).toBe(1);
      expect(spoken[0].text).toBe('hi');
      expect(spoken[0].lang).toBe('en-GB');
      expect(spoken[0].rate).toBe(1.5);
    } finally {
      delete (globalThis as any).window;
    }
  });

  test('web: listen streams a partial then resolves the final transcript on end', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    let inst: any = null;
    class FakeRecognition {
      lang = ''; interimResults = false; continuous = false;
      onresult: any = null; onerror: any = null; onend: any = null;
      constructor() { inst = this; }
      start() {
        // interim → final → end (mirrors the Web Speech event sequence)
        this.onresult({ results: [Object.assign([{ transcript: 'hel' }], { isFinal: false })] });
        this.onresult({ results: [Object.assign([{ transcript: 'hello world' }], { isFinal: true })] });
        this.onend();
      }
      stop() { this.onend?.(); }
    }
    (globalThis as any).window = { webkitSpeechRecognition: FakeRecognition };
    try {
      const web = new WebAdapter();
      const partials: string[] = [];
      web.on('speech.partial', (p: any) => partials.push(p.transcript));
      const final = await web.invoke('speech.listen', { partial: true });
      expect(final).toBe('hello world');
      expect(partials).toEqual(['hel']); // interim emitted, final not double-counted as partial
      expect(inst.interimResults).toBe(true);
    } finally {
      delete (globalThis as any).window;
    }
  });
});

describe('App badge', () => {
  test('capability reads the badge flag; badge(n) reuses the native notifications.setBadge path', async () => {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { badge: 'native' } }),
        invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return undefined as T; },
      })],
    });
    await kit.ready();
    expect(kit.app.badgeCapability).toBe('native');

    await kit.app.badge(3);
    await kit.app.badge(0);
    // DRY: the convenience wrapper rides the proven setBadge handler — no new native surface.
    expect(calls).toEqual([['notifications.setBadge', { count: 3 }], ['notifications.setBadge', { count: 0 }]]);
  });

  function stubWebEnv(navOverrides: Record<string, unknown>) {
    (globalThis as any).window = { Notification: function () {} };
    (globalThis as any).navigator = { ...navOverrides };
    (globalThis as any).screen = {};
    (globalThis as any).location = { hostname: 'app.test' };
    (globalThis as any).document = { title: 'Test' };
  }
  function clearWebEnv() {
    for (const k of ['window', 'navigator', 'screen', 'location', 'document']) delete (globalThis as any)[k];
  }

  test('web: capability=web + badge(n) calls the Badging API when present', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    const badged: number[] = [];
    stubWebEnv({ setAppBadge: async (n: number) => { badged.push(n); } });
    try {
      const hs = await new WebAdapter().handshake();
      expect(hs.capabilities.badge).toBe('web');
      await new WebAdapter().invoke('notifications.setBadge', { count: 5 });
      expect(badged).toEqual([5]);
    } finally {
      clearWebEnv();
    }
  });

  test('web: capability=none when the Badging API is absent', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    stubWebEnv({}); // no setAppBadge
    try {
      const hs = await new WebAdapter().handshake();
      expect(hs.capabilities.badge).toBe('none');
    } finally {
      clearWebEnv();
    }
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
            if (m === 'billing.appReceipt') return { platform: 'ios', appReceipt: 'rcpt', raw: {} } as T;
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

  test('entitlementsFromReceipt: default ClientTrustedValidator returns [] (a bare receipt has no product id → no bogus grant, no bridge read)', async () => {
    const { kit, calls } = billingKit();
    await kit.ready();
    expect(await kit.billing.entitlementsFromReceipt()).toEqual([]);
    expect(calls.some((c) => c[0] === 'billing.appReceipt')).toBe(false); // guarded before invoking
  });

  test('entitlementsFromReceipt: with a server validator, reads the receipt silently and returns server entitlements (no restore)', async () => {
    const { kit, calls } = billingKit();
    await kit.ready();
    let seenReceipt = '';
    kit.billing.configure({
      validator: {
        validate: async (r) => { seenReceipt = r.appReceipt ?? ''; return [{ productId: 'grandfathered', active: true }]; },
        entitlements: async () => [],
      },
    });
    expect(await kit.billing.entitlementsFromReceipt()).toEqual([{ productId: 'grandfathered', active: true }]);
    expect(seenReceipt).toBe('rcpt');
    expect(calls.some((c) => c[0] === 'billing.restore')).toBe(false); // silent — no Apple-ID prompt
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
