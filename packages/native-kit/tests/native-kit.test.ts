import { afterEach, describe, expect, jest, test } from 'bun:test';
import { NativeKit } from '../src/core/NativeKit';
import { AppwrapAdapter } from '../src/core/appwrap-adapter';
import { KitError, type Handshake, type NativeKitAdapter, type RequestEnvelope } from '../src/core/types';

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

describe('NativeKit hybrid web fallback', () => {
  function shellPlusWeb(webInvoke?: NativeKitAdapter['invoke'], webOn?: NativeKitAdapter['on']) {
    const shell = fakeAdapter({
      handshake: async () => ({
        ...structuredClone(HS),
        capabilities: { haptics: 'native', geo: 'none' } as Handshake['capabilities'],
      }),
      invoke: async <T,>(m: string) => {
        if (m === 'haptics.impact') return 'shell' as unknown as T;
        throw new KitError('UNSUPPORTED', `${m} not implemented`);
      },
    });
    const web = fakeAdapter({
      kind: 'web',
      handshake: async () => ({
        ...structuredClone(HS),
        platform: 'web',
        capabilities: { geo: 'web', speech: 'web', haptics: 'none' } as Handshake['capabilities'],
      }),
      invoke: webInvoke ?? (async <T,>() => 'web' as unknown as T),
      on: webOn ?? (() => () => {}),
    });
    return new NativeKit({ adapters: [shell, web] });
  }

  test('UNSUPPORTED from the shell retries against the web adapter; shell methods stay native', async () => {
    const kit = shellPlusWeb();
    await kit.ready();
    expect(await kit.invoke('haptics.impact')).toBe('shell');
    expect(await kit.invoke('geo.current')).toBe('web');
  });

  test("capability merge: absent keys become 'web'; an explicit shell 'none' is a veto", async () => {
    const kit = shellPlusWeb();
    await kit.ready();
    expect(kit.capability('haptics')).toBe('native'); // shell wins, web 'none' ignored
    expect(kit.capability('geo')).toBe('none'); // shell said 'none' explicitly — vetoed
    expect(kit.capability('speech')).toBe('web'); // absent from shell, web-provided
    expect(kit.capability('billing')).toBe('none'); // in neither
  });

  test('kit.on() also receives events emitted by the web fallback', async () => {
    let webCb: ((p: unknown) => void) | null = null;
    const kit = shellPlusWeb(undefined, (event, cb) => {
      if (event === 'geo.position') webCb = cb;
      return () => { webCb = null; };
    });
    await kit.ready();
    const got: unknown[] = [];
    const off = kit.on('geo.position', (p) => got.push(p));
    webCb!({ lat: 1, lng: 2 });
    expect(got).toEqual([{ lat: 1, lng: 2 }]);
    off();
    expect(webCb).toBeNull(); // unsubscribe tears down the fallback listener too
  });

  test('non-UNSUPPORTED shell errors are NOT retried on the web adapter', async () => {
    const kit = shellPlusWeb(async () => {
      throw new Error('web adapter must not be reached');
    });
    const shellErr = new KitError('DENIED', 'user said no');
    (kit.options.adapters[0] as NativeKitAdapter).invoke = async () => { throw shellErr; };
    await kit.ready();
    expect(kit.invoke('haptics.impact')).rejects.toBe(shellErr);
  });
});

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

  test('ready() falls back to the next detected adapter when the handshake fails', async () => {
    // A host shell can expose an appwrap-looking transport yet refuse the handshake
    // (capability-gated mini-app webview) — the kit must degrade to the web adapter.
    const webHS: Handshake = { ...HS, platform: 'web', capabilities: { motion: 'web' } };
    const kit = new NativeKit({
      adapters: [
        fakeAdapter({ handshake: async () => { throw new KitError('CAP_DENIED', 'no handshake for you'); } }),
        fakeAdapter({ kind: 'web', handshake: async () => webHS }),
      ],
    });
    const hs = await kit.ready();
    expect(hs.platform).toBe('web');
    expect(kit.capability('motion')).toBe('web');
  });

  test('ready() rejects with the last handshake error when every adapter fails', async () => {
    const kit = new NativeKit({
      adapters: [fakeAdapter({ handshake: async () => { throw new KitError('TIMEOUT', 'app.handshake timed out'); } })],
    });
    await expect(kit.ready()).rejects.toThrow(/timed out/);
  });
});

describe('Push', () => {
  test('register() returns the shell PushToken verbatim — incl. the bundle-id topic', async () => {
    const token = { platform: 'apns' as const, token: 'deadbeef', topic: 'cc.livx.test' };
    const kit = new NativeKit({
      adapters: [fakeAdapter({ invoke: async <T,>() => token as unknown as T })],
    });
    await kit.ready();
    expect(await kit.push.register()).toEqual(token);
  });

  test('register() tolerates a topic-less token (older shell / un-provisioned)', async () => {
    const kit = new NativeKit({
      adapters: [fakeAdapter({ invoke: async <T,>() => ({ platform: 'fcm', token: 't' }) as unknown as T })],
    });
    await kit.ready();
    expect((await kit.push.register()).topic).toBeUndefined();
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

describe('Heading (web-adapter compass math)', () => {
  // Stub a window whose addEventListener captures the orientation handler, a monotonically
  // advancing performance.now (so the throttle never drops our synthetic events), and a
  // DeviceOrientationEvent global. `absolute` controls which event feeds the handler.
  function stubOrientationEnv(absolute: boolean) {
    const handlers: Record<string, (e: any) => void> = {};
    const win: any = {
      addEventListener: (e: string, cb: (ev: any) => void) => { handlers[e] = cb; },
      removeEventListener: (e: string) => { delete handlers[e]; },
    };
    if (absolute) win.ondeviceorientationabsolute = null; // makes `'ondeviceorientationabsolute' in window` true
    (globalThis as any).window = win;
    (globalThis as any).DeviceOrientationEvent = function () {};
    let t = 0;
    (globalThis as any).performance = { now: () => (t += 1000) }; // always past the throttle gate
    return handlers;
  }
  function clear() {
    for (const k of ['window', 'DeviceOrientationEvent', 'performance']) delete (globalThis as any)[k];
  }

  test('Android deviceorientationabsolute: deg = (360 - alpha) normalized to [0,360)', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    const handlers = stubOrientationEnv(true);
    try {
      const web = new WebAdapter();
      const samples: Array<{ deg: number }> = [];
      web.on('heading.data', (s) => samples.push(s as { deg: number }));
      await web.invoke('heading.start', {});
      const h = handlers['deviceorientationabsolute'];
      expect(typeof h).toBe('function'); // bound the absolute event, not the iOS one
      for (const alpha of [0, 90, 270, 360]) h({ absolute: true, alpha });
      expect(samples.map((s) => s.deg)).toEqual([0, 270, 90, 0]);
    } finally {
      clear();
    }
  });

  test('iOS webkitCompassHeading passes through as-is, normalized to [0,360)', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    const handlers = stubOrientationEnv(false); // no absolute event → binds 'deviceorientation'
    try {
      const web = new WebAdapter();
      const samples: Array<{ deg: number; accuracy?: number }> = [];
      web.on('heading.data', (s) => samples.push(s as { deg: number; accuracy?: number }));
      await web.invoke('heading.start', {});
      const h = handlers['deviceorientation'];
      expect(typeof h).toBe('function');
      h({ webkitCompassHeading: 123.4, webkitCompassAccuracy: 5 });
      h({ webkitCompassHeading: 360 }); // 360 wraps to 0
      expect(samples[0].deg).toBeCloseTo(123.4, 5); // passed through as-is (mod-360 FP wobble aside)
      expect(samples[0].accuracy).toBe(5);
      expect(samples[1].deg).toBe(0);
    } finally {
      clear();
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

describe('App — canOpenUrl + shortcuts (Loop B)', () => {
  test('canOpenUrl + setShortcuts route namespaced; onShortcut forwards the id', async () => {
    const calls: Array<[string, unknown]> = [];
    const handlers = new Map<string, (p: unknown) => void>();
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { app: 'native', shortcuts: 'native' } }),
        invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return (m === 'app.canOpenUrl' ? true : undefined) as T; },
        on: (e, cb) => { handlers.set(e, cb); return () => {}; },
      })],
    });
    await kit.ready();
    expect(kit.app.shortcutsCapability).toBe('native');

    expect(await kit.app.canOpenUrl('whatsapp://send')).toBe(true);
    await kit.app.setShortcuts([{ id: 'new', title: 'New', subtitle: 'Create' }]);
    expect(calls).toEqual([
      ['app.canOpenUrl', { url: 'whatsapp://send' }],
      ['app.setShortcuts', { items: [{ id: 'new', title: 'New', subtitle: 'Create' }] }],
    ]);

    const ids: string[] = [];
    kit.app.onShortcut((id) => ids.push(id));
    handlers.get('app.shortcut')!({ id: 'search' });
    expect(ids).toEqual(['search']);
  });

  test('web: canOpenUrl is honestly false; setShortcuts is a no-op; caps report none', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    (globalThis as any).window = { Notification: function () {} };
    (globalThis as any).navigator = {};
    (globalThis as any).screen = {};
    (globalThis as any).location = { hostname: 'x' };
    (globalThis as any).document = { title: 't' };
    try {
      const caps = (await new WebAdapter().handshake()).capabilities;
      expect(caps.shortcuts).toBe('none');
      expect(await new WebAdapter().invoke('app.canOpenUrl', { url: 'whatsapp://x' })).toBe(false);
      expect(await new WebAdapter().invoke('app.setShortcuts', { items: [{ id: 'a', title: 'A' }] })).toBeUndefined();
    } finally {
      for (const k of ['window', 'navigator', 'screen', 'location', 'document']) delete (globalThis as any)[k];
    }
  });
});

describe('Screen — privacy screen (Loop B)', () => {
  test('setPrivacy routes namespaced with the enabled flag; capability gates', async () => {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { privacyScreen: 'native' } }),
        invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return undefined as T; },
      })],
    });
    await kit.ready();
    expect(kit.screen.privacyCapability).toBe('native');
    await kit.screen.setPrivacy(true);
    await kit.screen.setPrivacy(false);
    expect(calls).toEqual([
      ['screen.setPrivacy', { enabled: true }],
      ['screen.setPrivacy', { enabled: false }],
    ]);
  });

  test('web: privacyScreen cap is none; setPrivacy is an honest no-op', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    (globalThis as any).window = {};
    (globalThis as any).navigator = {};
    (globalThis as any).screen = {};
    (globalThis as any).location = { hostname: 'x' };
    (globalThis as any).document = { title: 't' };
    try {
      expect((await new WebAdapter().handshake()).capabilities.privacyScreen).toBe('none');
      expect(await new WebAdapter().invoke('screen.setPrivacy', { enabled: true })).toBeUndefined();
    } finally {
      for (const k of ['window', 'navigator', 'screen', 'location', 'document']) delete (globalThis as any)[k];
    }
  });

  test('manifest: shortcuts + privacyScreen resolve native on both platforms (core, never stripped)', async () => {
    const { buildCapabilityMap } = await import('../../../runtime/app/shell/capabilities.manifest');
    for (const platform of ['ios', 'android'] as const) {
      const map = buildCapabilityMap(new Set<string>(), platform); // empty active set → core still on
      expect(map.shortcuts).toBe('native');
      expect(map.privacyScreen).toBe('native');
    }
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

  test('default watchdog rejects with TIMEOUT after the window', async () => {
    const { adapter, posted, win } = wired();
    adapter.handshake(1000).catch(() => {}); // installs deliver
    const p = adapter.invoke('billing.purchase', {}, { timeoutMs: 5 });
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT', name: 'KitError' });
    expect(posted.some((m) => m.method === 'billing.purchase')).toBe(true);
    delete (globalThis as any).window;
  });

  test("timeoutMs 'none' / 0 disables the watchdog (dismiss-bound calls)", async () => {
    for (const timeoutMs of ['none', 0] as const) {
      const { adapter, posted, win } = wired();
      adapter.handshake(1000).catch(() => {}); // installs deliver
      let settled = false;
      const p = adapter.invoke('billing.manageSubscriptionsSheet', undefined, { timeoutMs })
        .then((v) => { settled = true; return v; });
      // Past any default deadline, still pending — only the native response settles it.
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false);
      const req = posted.find((m) => m.method === 'billing.manageSubscriptionsSheet')!;
      win.__appwrapDeliver(JSON.stringify({ v: 1, id: req.id, kind: 'response', result: null }));
      await p;
      expect(settled).toBe(true);
      delete (globalThis as any).window;
    }
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

// Manifest is pure data (no NativeScript globals) → importable straight into a bun test.
describe('capability manifest — oauth + reviews Android parity', () => {
  test('reviews is now a STRIPPABLE optional group (own handler, not always-bundled)', async () => {
    const { MODULES, OPTIONAL_GROUPS } = await import('../../../runtime/app/shell/capabilities.manifest');
    const reviews = MODULES.find((m) => m.name === 'reviews')!;
    expect(reviews).toBeDefined();
    expect(reviews.core).toBeFalsy();          // opt-in
    expect(reviews.group).toBe('reviews');     // its own group, not the always-bundled 'system'
    expect(OPTIONAL_GROUPS).toContain('reviews'); // CLI gates/strips it like scanner/speech
    // Android Play In-App Review dep rides ONLY with the module (so a build without reviews stays clean).
    expect(reviews.android?.gradleDeps ?? []).toContain('com.google.android.play:review:2.0.2');
  });

  test('oauth + reviews resolve android:true when active; absent when stripped', async () => {
    const { buildCapabilityMap } = await import('../../../runtime/app/shell/capabilities.manifest');

    const active = buildCapabilityMap(new Set(['oauth', 'reviews']), 'android');
    expect(active.oauth).toBe('native');   // was 'none' before this change
    expect(active.reviews).toBe('native'); // was 'none' before this change

    // iOS keeps parity too.
    const ios = buildCapabilityMap(new Set(['oauth', 'reviews']), 'ios');
    expect(ios.oauth).toBe('native');
    expect(ios.reviews).toBe('native');

    // Stripped (not in the active set) → the cap isn't advertised at all (opt-in modules vanish).
    const stripped = buildCapabilityMap(new Set<string>(), 'android');
    expect(stripped.oauth).toBeUndefined();
    expect(stripped.reviews).toBeUndefined();
  });
});

describe('BackgroundTask — headless dispatch contract (Loop C)', () => {
  // A kit whose handshake carries an optional backgroundTaskId, recording every invoke for assertions.
  function bgKit(backgroundTaskId?: string) {
    const calls: Array<[string, unknown]> = [];
    const kit = new NativeKit({
      adapters: [fakeAdapter({
        handshake: async () => ({ ...HS, capabilities: { backgroundTask: 'native' }, ...(backgroundTaskId ? { backgroundTaskId } : {}) }),
        invoke: async <T,>(m: string, p?: unknown) => { calls.push([m, p]); return undefined as T; },
      })],
    });
    return { kit, calls };
  }

  test('(a) wake handshake + register → handler invoked with an AbortSignal', async () => {
    const { kit } = bgKit('sync');
    let seen: { id: string; signal: AbortSignal } | null = null;
    kit.backgroundTask.register('sync', async (ctx) => { seen = ctx; });
    await kit.ready();
    await Bun.sleep(0); // let the dispatch microtask run
    expect(kit.backgroundTask.capability).toBe('native');
    expect(seen!.id).toBe('sync');
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
    expect(seen!.signal.aborted).toBe(false);
  });

  test('(b1) register BEFORE ready dispatches once ready resolves', async () => {
    const { kit, calls } = bgKit('sync');
    const ran: string[] = [];
    kit.backgroundTask.register('sync', async () => { ran.push('sync'); });
    expect(ran).toEqual([]);          // nothing yet — ready hasn't resolved
    await kit.ready();
    await Bun.sleep(0);
    expect(ran).toEqual(['sync']);
    expect(calls.some(([m]) => m === 'backgroundTask.finish')).toBe(true);
  });

  test('(b2) register AFTER ready (late) still dispatches the pending wake', async () => {
    const { kit } = bgKit('sync');
    await kit.ready();                 // wake id arrives, no handler yet → remembered
    await Bun.sleep(0);
    const ran: string[] = [];
    kit.backgroundTask.register('sync', async () => { ran.push('sync'); });
    await Bun.sleep(0);
    expect(ran).toEqual(['sync']);
  });

  test('a non-matching wake id never dispatches a different handler', async () => {
    const { kit } = bgKit('other');
    const ran: string[] = [];
    kit.backgroundTask.register('sync', async () => { ran.push('sync'); });
    await kit.ready();
    await Bun.sleep(0);
    expect(ran).toEqual([]);           // wake was for 'other', no 'other' handler → nothing runs
  });

  test('NO wake id (foreground launch) → register records but never auto-dispatches', async () => {
    const { kit, calls } = bgKit(); // handshake without backgroundTaskId
    const ran: string[] = [];
    kit.backgroundTask.register('sync', async () => { ran.push('sync'); });
    await kit.ready();
    await Bun.sleep(0);
    expect(ran).toEqual([]);
    expect(calls.some(([m]) => m.startsWith('backgroundTask.'))).toBe(false);
  });

  test('(c) handler completion → backgroundTask.finish invoked with { id, success:true }', async () => {
    const { kit, calls } = bgKit('sync');
    kit.backgroundTask.register('sync', async () => { /* ok */ });
    await kit.ready();
    await Bun.sleep(0);
    expect(calls).toContainEqual(['backgroundTask.finish', { id: 'sync', success: true }]);
  });

  test('a rejecting handler reports finish with success:false (the OS still reschedules)', async () => {
    const { kit, calls } = bgKit('sync');
    kit.backgroundTask.register('sync', async () => { throw new Error('boom'); });
    await kit.ready();
    await Bun.sleep(0);
    expect(calls).toContainEqual(['backgroundTask.finish', { id: 'sync', success: false }]);
  });

  test('dispatch is once-per-session: replay + ready both matching fire the handler ONCE', async () => {
    const { kit, calls } = bgKit('sync');
    let runs = 0;
    kit.backgroundTask.register('sync', async () => { runs++; });
    await kit.ready();
    await Bun.sleep(0);
    // re-register (idempotent boot call) must not re-fire the already-dispatched wake
    kit.backgroundTask.register('sync', async () => { runs++; });
    await Bun.sleep(0);
    expect(runs).toBe(1);
    expect(calls.filter(([m]) => m === 'backgroundTask.finish').length).toBe(1);
  });

  test('(d) the safety timeout aborts the handler signal (below the iOS ~30s budget)', async () => {
    jest.useFakeTimers();
    try {
      const { kit, calls } = bgKit('sync');
      let aborted = false;
      let resolveHandler!: () => void;
      // A handler that hangs until aborted (then resolves) — mirrors a real long-running task.
      kit.backgroundTask.register('sync', (ctx) =>
        new Promise<void>((res) => {
          resolveHandler = res;
          ctx.signal.addEventListener('abort', () => { aborted = true; res(); });
        })
      );
      await kit.ready();          // dispatch starts, arms the 25s timer
      await Promise.resolve();    // let dispatch reach the await
      expect(aborted).toBe(false);
      jest.advanceTimersByTime(25_000); // cross the safety threshold → abort fires
      expect(aborted).toBe(true);
      // drain the finally (finish report) — real microtasks under fake timers
      jest.useRealTimers();
      void resolveHandler;
      await Bun.sleep(0);
      expect(calls).toContainEqual(['backgroundTask.finish', { id: 'sync', success: true }]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('(e) web: schedule/cancel are no-op resolves; capability is none; register records nothing native', async () => {
    const { WebAdapter } = await import('../src/core/web-adapter');
    (globalThis as any).window = {};
    (globalThis as any).navigator = {};
    (globalThis as any).screen = {};
    (globalThis as any).location = { hostname: 'x' };
    (globalThis as any).document = { title: 't' };
    try {
      const web = new WebAdapter();
      expect((await web.handshake()).capabilities.backgroundTask).toBe('none');
      expect(await web.invoke('backgroundTask.schedule', { id: 'sync' })).toBeUndefined();
      expect(await web.invoke('backgroundTask.cancel', { id: 'sync' })).toBeUndefined();
    } finally {
      for (const k of ['window', 'navigator', 'screen', 'location', 'document']) delete (globalThis as any)[k];
    }
  });

  test('module methods route schedule/cancel to namespaced backgroundTask.* with params merged', async () => {
    const { kit, calls } = bgKit(); // no wake — just routing
    await kit.ready();
    await kit.backgroundTask.schedule({ id: 'sync', minIntervalMs: 900000, requiresNetwork: true });
    await kit.backgroundTask.cancel('sync');
    expect(calls).toEqual([
      ['backgroundTask.schedule', { id: 'sync', minIntervalMs: 900000, requiresNetwork: true }],
      ['backgroundTask.cancel', { id: 'sync' }],
    ]);
  });

  test('(f) buildCapabilityMap gates backgroundTask off when inactive, native when active (both platforms)', async () => {
    const { buildCapabilityMap } = await import('../../../runtime/app/shell/capabilities.manifest');
    for (const platform of ['ios', 'android'] as const) {
      expect(buildCapabilityMap(new Set<string>(), platform).backgroundTask).toBeUndefined();
      expect(buildCapabilityMap(new Set(['backgroundTask']), platform).backgroundTask).toBe('native');
    }
  });
});
