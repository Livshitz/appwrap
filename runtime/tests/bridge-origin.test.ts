import { describe, expect, mock, test } from 'bun:test';

// Same superset @nativescript/core mock as the other runtime tests (shared module cache).
mock.module('@nativescript/core', () => ({
  Http: { request: async () => ({ content: null }) },
  isIOS: false, isAndroid: false, WebView: class {},
  ApplicationSettings: { getString: (_k: string, d = '') => d, setString: () => {}, remove: () => {} },
  Dialogs: { confirm: async () => true, action: async () => '', alert: async () => undefined, prompt: async () => ({ result: false, text: '' }) },
  Utils: { dispatchToMainThread: (fn: () => void) => fn() },
  Application: { on: () => {}, suspendEvent: 's', resumeEvent: 'r', orientationChangedEvent: 'o', android: {} },
  Connectivity: { startMonitoring: () => {} },
}));

const { SHELL_CONFIG } = await import('../app/shell/config');
const { Bridge } = await import('../app/shell/bridge');
const { bridgeAllows, originOf } = await import('../app/shell/bridge-origin');

/** A request from a page of `origin`; resolves with the response envelope the bridge delivers. */
async function call(method: string, origin: string) {
  const b = new Bridge();
  const view: any = { onAppwrapMessage: null };
  b.attach(view);
  b.register(method, () => 'secret');
  let out: any;
  b.evalJs = async (js: string) => { out = JSON.parse(JSON.parse(js.slice(js.indexOf('(') + 1, js.lastIndexOf(')')))); };
  view.onAppwrapMessage(JSON.stringify({ v: 1, id: 'k', kind: 'request', method }), origin);
  await new Promise((r) => setTimeout(r, 20));
  return out;
}

describe('Bridge origin gate — a foreign page must not reach the app’s stored data', () => {
  test('the app origin keeps the full bridge', async () => {
    expect((await call('storage.secure.get', 'app://localhost')).result).toBe('secret');
  });

  test('a foreign page (a LAN/Tailscale server) is FORBIDDEN storage.secure, fs, webview cookies', async () => {
    for (const m of ['storage.secure.get', 'storage.get', 'fs.read', 'webview.getCookies', 'webview.eval', 'webview.snapshot', 'clipboard.read', 'share.files']) {
      const r = await call(m, 'http://192.168.1.5:7707');
      expect(r.result).toBeUndefined();
      expect(r.error.code).toBe('FORBIDDEN');
    }
  });

  test('an unknown origin fails closed', async () => {
    expect((await call('storage.secure.get', '')).error.code).toBe('FORBIDDEN');
  });

  test('a foreign page keeps UI feedback + permission-prompted features', () => {
    for (const m of ['haptics.impact', 'keyboard.hide', 'share.share', 'ui.statusBar.setStyle', 'push.register', 'app.handshake'])
      expect(bridgeAllows('https://evil.example', m)).toBe(true);
  });

  test('server loader: its own origin (default port, any path) is trusted; a lookalike is not', () => {
    const prev = { loader: SHELL_CONFIG.loader, serverUrl: SHELL_CONFIG.serverUrl };
    Object.assign(SHELL_CONFIG, { loader: 'server', serverUrl: 'https://app.example.com/start?x=1' });
    try {
      expect(bridgeAllows('https://app.example.com:443', 'storage.secure.get')).toBe(true);
      expect(bridgeAllows('https://app.example.com.evil.io', 'storage.secure.get')).toBe(false);
      expect(bridgeAllows('http://app.example.com', 'storage.secure.get')).toBe(false);
    } finally { Object.assign(SHELL_CONFIG, prev); }
  });

  test('originOf normalises', () => {
    expect(originOf('HTTP://U:p@Host:80/a?b#c')).toBe('http://host');
    expect(originOf('app://localhost/index.html')).toBe('app://localhost');
    expect(originOf('not a url')).toBe('');
  });
});
