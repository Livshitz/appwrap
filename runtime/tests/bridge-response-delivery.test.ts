import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The shell imports NativeScript globals at module load; the bridge only needs isIOS/isAndroid.
// Superset shape — bun shares the runtime-module cache across files in a dir run, so every
// @nativescript/core mock must expose the same named exports the runtime modules import.
mock.module('@nativescript/core', () => ({
  isIOS: false, isAndroid: false, WebView: class {},
  ApplicationSettings: { getString: (_k: string, d = '') => d, setString: () => {}, remove: () => {} },
  Dialogs: { confirm: async () => true, action: async () => '', alert: async () => undefined, prompt: async () => ({ result: false, text: '' }) },
  Utils: { dispatchToMainThread: (fn: () => void) => fn() },
  Application: { on: () => {}, suspendEvent: 's', resumeEvent: 'r', orientationChangedEvent: 'o', android: {} },
  Connectivity: { startMonitoring: () => {} },
}));

const { Bridge } = await import('../app/shell/bridge');

/** Drive the bridge like the real WebView does: feed it a request envelope, capture what it evals. */
function harness(evalImpl: (js: string) => Promise<unknown>) {
  const b = new Bridge();
  const view: any = { onAppwrapMessage: null };
  b.attach(view);
  b.evalJs = evalImpl;
  const delivered: any[] = [];
  const send = (method: string, id = 'k1') => view.onAppwrapMessage(JSON.stringify({ v: 1, id, kind: 'request', method }));
  /** Parse an envelope back out of the `window.__appwrapDeliver("…")` script the bridge builds. */
  const parse = (js: string) => JSON.parse(JSON.parse(js.slice(js.indexOf('(') + 1, js.lastIndexOf(')'))));
  return { b, send, delivered, parse };
}

/** Comfortably longer than the (shrunken) retry window, so the give-up path has fully run. */
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('Bridge response delivery — a lost response must never become a false TIMEOUT', () => {
  beforeEach(() => {
    Bridge.responseRetryMs = 1;
    Bridge.responseRetryWindowMs = 30;
    Bridge.responseAttemptTimeoutMs = 5;
  });

  test('REGRESSION (the user bug): a response failing while the renderer is throttled is RETRIED, not swallowed', async () => {
    // iOS freezes the WebContent renderer for ~30-45s under a permission alert: evaluateJavaScript
    // never runs. Old behaviour: one attempt, .catch(console.error) → the caller hung to its 60s watchdog.
    let attempts = 0;
    const { b, send, parse } = harness(async (js) => {
      if (++attempts < 4) throw new Error('renderer throttled');
      return parse(js);
    });
    const seen: any[] = [];
    b.register('geo.current', () => { throw Object.assign(new Error('location timeout'), { code: 'TIMEOUT' }); });
    b.evalJs = async (js: string) => {
      if (attempts++ < 3) throw new Error('renderer throttled');
      seen.push(parse(js));
    };
    send('geo.current');
    await settle();

    expect(attempts).toBeGreaterThan(3); // it kept trying while frozen
    expect(seen).toHaveLength(1); // and the answer LANDED once the renderer woke
    expect(seen[0].error.code).toBe('TIMEOUT');
  });

  test('an eval that NEVER completes (frozen renderer) still retries — it must not stall the loop', async () => {
    // WKWebView under a system alert may never invoke the completion handler at all, so the eval
    // promise stays pending forever. A retry loop that only reacts to REJECTION would hang here.
    let attempts = 0;
    const seen: any[] = [];
    const { b, send, parse } = harness(() => new Promise(() => {})); // never settles
    b.register('geo.current', () => { throw Object.assign(new Error('location timeout'), { code: 'TIMEOUT' }); });
    b.evalJs = ((js: string) => {
      if (++attempts < 3) return new Promise(() => {}); // renderer frozen: no callback, ever
      seen.push(parse(js));
      return Promise.resolve(undefined);
    }) as any;
    send('geo.current');
    await settle();

    expect(attempts).toBeGreaterThanOrEqual(3); // the per-attempt cap broke the stall
    expect(seen).toHaveLength(1);
    expect(seen[0].error.code).toBe('TIMEOUT'); // and the real answer finally landed
  });

  test('a permanently undeliverable response is reported LOUDLY, never in silence', async () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: any[]) => { errs.push(a.map(String).join(' ')); };
    try {
      const { b, send } = harness(async () => { throw new Error('webview gone'); });
      b.register('geo.current', () => { throw Object.assign(new Error('nope'), { code: 'DENIED' }); });
      send('geo.current');
      await settle();
      const line = errs.find((e) => e.includes('UNDELIVERABLE'));
      expect(line).toBeDefined();
      expect(line).toContain('false TIMEOUT'); // names the exact user-visible consequence
      expect(line).toContain('DENIED'); // and the real reason we failed to convey
    } finally { console.error = orig; }
  });

  test('a rejecting handler still answers with ITS code — a permission never masquerades as a timeout', async () => {
    const seen: any[] = [];
    const { b, send, parse } = harness(async (js) => { seen.push(parse(js)); });
    b.register('geo.current', () => { throw Object.assign(new Error('location permission denied'), { code: 'DENIED' }); });
    send('geo.current');
    await settle();
    expect(seen[0].error).toEqual({ code: 'DENIED', message: 'location permission denied' });
  });

  test('an unknown method answers UNSUPPORTED fast (no silent drop → no false timeout)', async () => {
    const seen: any[] = [];
    const { b, send, parse } = harness(async (js) => { seen.push(parse(js)); });
    send('geo.nope');
    await settle();
    expect(seen[0].error.code).toBe('UNSUPPORTED');
  });

  test('retry is response-only: events stay one-shot (they are not idempotent)', async () => {
    let calls = 0;
    const { b } = harness(async () => { calls++; throw new Error('down'); });
    b.emit('geo.position', { lat: 1, lng: 2 });
    await settle();
    expect(calls).toBe(1);
  });
});
