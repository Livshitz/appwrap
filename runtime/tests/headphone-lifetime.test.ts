import { describe, expect, mock, test } from 'bun:test';

// Superset mock shared with the other runtime tests (bun shares the module cache across files in a dir run).
mock.module('@nativescript/core', () => ({
  Http: { request: async () => ({ content: null }) },
  isIOS: false, isAndroid: false, WebView: class {},
  ApplicationSettings: { getString: (_k: string, d = '') => d, setString: () => {}, remove: () => {} },
  Dialogs: { confirm: async () => true, action: async () => '', alert: async () => undefined, prompt: async () => ({ result: false, text: '' }) },
  Utils: { dispatchToMainThread: (fn: () => void) => fn() },
  Application: { on: () => {}, suspendEvent: 's', resumeEvent: 'r', orientationChangedEvent: 'o', android: {} },
  Connectivity: { startMonitoring: () => {} },
}));

const { Bridge } = await import('../app/shell/bridge');
const { headphoneStartBlocker } = await import('../app/shell/headphone-gate');

/** Feed envelopes the way the iOS transport does: (json, origin, mainFrame). */
function harness() {
  const b = new Bridge();
  const view: any = { onAppwrapMessage: null };
  b.attach(view);
  b.evalJs = async () => {};
  b.register('app.handshake', () => ({}));
  let resets = 0;
  b.onNewDocument(() => resets++);
  const send = (method: string, mainFrame?: boolean) =>
    view.onAppwrapMessage(JSON.stringify({ v: 1, id: String(Math.random()), kind: 'request', method }), 'app://localhost', mainFrame);
  return { send, resets: () => resets };
}

describe('head-tracking stream lifetime = the top-level document', () => {
  test('an iframe handshake (mini-app navigating / reloading) does NOT reset — the stream keeps running', () => {
    const h = harness();
    h.send('app.handshake', false);
    expect(h.resets()).toBe(0);
  });

  test('a main-frame handshake (new document: reload OR navigation) resets — the stream stops', () => {
    const h = harness();
    h.send('app.handshake', true);
    expect(h.resets()).toBe(1);
  });

  test('other main-frame calls do not reset; a transport that cannot tell (Android) counts as main', () => {
    const h = harness();
    h.send('headphoneMotion.start', true);
    expect(h.resets()).toBe(0);
    h.send('app.handshake', undefined);
    expect(h.resets()).toBe(1);
  });
});

describe('headphoneMotion.start refuses instead of hanging or crashing', () => {
  test('denied / restricted → PERMISSION_DENIED (CoreMotion would otherwise send nothing, forever)', () => {
    expect(headphoneStartBlocker(true, 'denied')?.code).toBe('PERMISSION_DENIED');
    expect(headphoneStartBlocker(true, 'restricted')?.code).toBe('PERMISSION_DENIED');
  });
  test('missing usage key → NOT_CONFIGURED (takes precedence: iOS would kill the process)', () => {
    expect(headphoneStartBlocker(false, 'denied')?.code).toBe('NOT_CONFIGURED');
  });
  test('notDetermined (prompt on start) / authorized → proceed', () => {
    expect(headphoneStartBlocker(true, 'notDetermined')).toBeNull();
    expect(headphoneStartBlocker(true, 'authorized')).toBeNull();
  });
});
