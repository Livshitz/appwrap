/**
 * An env switch must NEVER promise "The app will reload" and then silently not reload
 * (runtime/app/shell/env-switcher.ts).
 *
 * Incident: a switch to a custom URL whose dev server was DOWN persisted the override correctly, but the
 * WebView's load hit a refused connection and simply stayed on the previous page. `reloadToEffective`
 * reported nothing — no log, no dialog — so the switch read as "didn't work". It had worked: a relaunch
 * landed on the new env. The defect was purely the missing feedback, and the missing fact was "the
 * override IS saved; relaunch to use it".
 *
 * These tests drive the REAL `showEnvSwitcher` → 'Other…' → `applySwitch` → `reloadToEffective` path and
 * assert the user-visible outcome via the NativeScript seams:
 *   • no WebView          → a signal, not a silent `return`
 *   • load FAILED         → a message naming the host + reason, stating the override survives to relaunch
 *   • load OK             → NO spurious message
 * and that the persisted override is UNCHANGED in every case (the persistence logic was never the bug).
 *
 * The failure seam is NS's own `loadFinished` event (`args.error`), which both platforms populate for a
 * main-frame failure — iOS via didFail[Provisional]Navigation, Android via WebViewClient.onReceivedError
 * (forwarded to NS in custom-webview.android.ts, since our client replaces NS's).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store: Record<string, string> = {};
let actionResult = '';
let promptText = '';
let alerts: Record<string, any>[] = [];
let warnings: string[] = [];

/** Minimal stand-in for the NS WebView's Observable seam — enough to assert one-shot listener hygiene. */
class FakeWebView {
  listeners: Record<string, ((args: any) => void)[]> = {};
  on(event: string, cb: (args: any) => void) { (this.listeners[event] ??= []).push(cb); }
  off(event: string, cb: (args: any) => void) {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== cb);
  }
  /** Raise what NS raises after a load settles: `error` set = failed, absent = succeeded. */
  finishLoad(url: string, error?: string) {
    for (const cb of [...(this.listeners['loadFinished'] ?? [])]) cb({ url, error });
  }
  count(event: string) { return (this.listeners[event] ?? []).length; }
}

let webView: FakeWebView | null = null;

mock.module('@nativescript/core', () => ({
  ApplicationSettings: {
    getString: (k: string, d = '') => (k in store ? store[k] : d),
    setString: (k: string, v: string) => { store[k] = v; },
    remove: (k: string) => { delete store[k]; },
  },
  Dialogs: {
    confirm: async () => true,
    action: async () => actionResult,
    alert: async (opts: Record<string, any>) => { alerts.push(opts); },
    prompt: async () => ({ result: true, text: promptText }),
  },
  Utils: { dispatchToMainThread: (fn: () => void) => fn() },
  Application: { on: () => {}, suspendEvent: 's', resumeEvent: 'r', orientationChangedEvent: 'o', android: {} },
  Connectivity: { startMonitoring: () => {} },
  isAndroid: false,
  isIOS: false,
}));

mock.module('../../../runtime/app/shell/config', () => ({
  SHELL_CONFIG: {
    loader: 'server',
    serverUrl: 'https://agf.circlesup.com',
    envSwitcher: {
      enabled: true,
      envs: [{ label: 'Prod', url: 'https://agf.circlesup.com' }],
      allowPattern: '^https://(lab\\.agf\\.circlesup\\.com|elya---circles\\.local(:\\d+)?)(/.*)?$',
    },
  },
}));
mock.module('../../../runtime/app/shell/bridge', () => ({ bridge: { getWebView: () => webView } }));
mock.module('../../../runtime/app/shell/env-banner', () => ({
  refreshEnvBanner: () => {},
  showEnvBannerIfActive: () => {},
  hideEnvBanner: () => {},
}));

const { showEnvSwitcher, currentOverride } = await import('../../../runtime/app/shell/env-switcher');

const TARGET = 'https://elya---circles.local:3000';
/** The incident's exact shape: a refused connection to a dev server that wasn't running. */
const REFUSED = 'Could not connect to the server.';

/** Drive the real 'Other…' → custom-URL → confirm → apply path. */
const switchToCustom = async (url = TARGET) => {
  actionResult = 'Other…';
  promptText = url;
  await showEnvSwitcher();
};

describe('an env switch never silently fails to reload', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    alerts = [];
    warnings = [];
    webView = new FakeWebView();
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  });

  test('no WebView: the user/log is told, instead of a silent return', async () => {
    webView = null;
    await switchToCustom();
    expect(alerts.length).toBe(1);
    expect(warnings.join('\n')).toContain('elya---circles.local:3000');
    // The override still persisted — a relaunch WILL apply it, which is what the message must promise.
    expect(currentOverride()).toBe(TARGET);
    expect(alerts[0].message).toMatch(/relaunch/i);
  });

  test('load FAILS: the message names the host and the reason', async () => {
    await switchToCustom();
    webView!.finishLoad(TARGET, REFUSED);
    expect(alerts.length).toBe(1);
    expect(alerts[0].message).toContain('elya---circles.local:3000'); // which env
    expect(alerts[0].message).toContain(REFUSED); // why — the fact that was missing
  });

  test('load FAILS: the message says the override is saved and applies on relaunch', async () => {
    await switchToCustom();
    webView!.finishLoad(TARGET, REFUSED);
    // The precise information the incident lacked: the switch DID persist; only the live reload didn't.
    expect(alerts[0].message).toMatch(/saved/i);
    expect(alerts[0].message).toMatch(/relaunch/i);
    expect(currentOverride()).toBe(TARGET); // persistence untouched by the feedback path
  });

  test('load SUCCEEDS: no spurious error is shown', async () => {
    await switchToCustom();
    webView!.finishLoad(TARGET); // no error arg = loaded fine
    expect(alerts).toEqual([]);
    expect(currentOverride()).toBe(TARGET);
  });

  test('the failure listener is one-shot: a later unrelated load error is not blamed on the switch', async () => {
    await switchToCustom();
    webView!.finishLoad(TARGET); // this switch's load settled OK
    expect(webView!.count('loadFinished')).toBe(0); // unhooked — no leak across switches
    webView!.finishLoad('https://elya---circles.local:3000/other', 'A later, unrelated failure.');
    expect(alerts).toEqual([]);
  });

  test('a rejected (non-allowlisted) URL neither reloads nor reports a reload failure', async () => {
    await switchToCustom('https://evil.example.com');
    expect(currentOverride()).toBe(''); // validation not weakened
    // Exactly one alert: "not allowed" — NOT a reload-failure message (no switch was attempted).
    expect(alerts.length).toBe(1);
    expect(alerts[0].title).toBe('Not allowed');
  });
});
