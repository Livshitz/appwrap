/**
 * "Custom env" URL prompt must accept a PASTED url (runtime/app/shell/env-switcher.ts).
 *
 * Regression: `promptOther` prefilled the field with `defaultText: 'https://'`. A URL is the one input
 * class users always paste, and a copied URL carries its own scheme; iOS pastes at the CARET, which sits
 * after the prefill → the field became `https://https://host`, which `allowPattern` rejects ("Not
 * allowed"). Typing masked it (you type the host after the prefix), so it surfaced as "paste is broken".
 *
 * These tests drive the REAL `showEnvSwitcher` → 'Other…' → `promptOther` path and model an iOS paste as
 * `<whatever the field is prefilled with> + <clipboard>` — so re-adding any prefill fails them. The
 * allowlist itself is untouched: a non-allowlisted paste must STILL be rejected.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store: Record<string, string> = {};
let actionResult = '';
let promptOptions: Record<string, any> | null = null;
/** Models the user's interaction: given the text the field is PRE-LOADED with, returns what the field
 * holds when they tap "Next". Lets each test express paste-at-caret vs. typing distinctly. */
let respond: (field: string) => string = (field) => field;

/** iOS paste: the clipboard is INSERTED at the caret, which sits at the end of any prefilled text. */
const pastes = (clipboard: string) => (field: string) => field + clipboard;

mock.module('@nativescript/core', () => ({
  ApplicationSettings: {
    getString: (k: string, d = '') => (k in store ? store[k] : d),
    setString: (k: string, v: string) => { store[k] = v; },
    remove: (k: string) => { delete store[k]; },
  },
  Dialogs: {
    confirm: async () => true,
    action: async () => actionResult,
    alert: async () => undefined,
    // Models the native UIAlertController text field: it starts out holding `defaultText`, then the
    // user acts on it (`respond`) and confirms.
    prompt: async (opts: Record<string, any>) => {
      promptOptions = opts;
      const field = typeof opts.defaultText === 'string' ? opts.defaultText : '';
      return { result: true, text: respond(field) };
    },
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
mock.module('../../../runtime/app/shell/bridge', () => ({ bridge: { getWebView: () => null } }));
mock.module('../../../runtime/app/shell/env-banner', () => ({
  refreshEnvBanner: () => {},
  showEnvBannerIfActive: () => {},
  hideEnvBanner: () => {},
}));

const { showEnvSwitcher } = await import('../../../runtime/app/shell/env-switcher');
const { currentOverride } = await import('../../../runtime/app/shell/env-switcher');

describe('custom env prompt accepts a pasted URL', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    promptOptions = null;
    actionResult = 'Other…';
    respond = (field) => field;
  });

  test('the field is empty, so a paste cannot be contaminated by a prefill', async () => {
    respond = pastes('https://lab.agf.circlesup.com');
    await showEnvSwitcher();
    // A prefill is what doubled the scheme — assert there is none.
    expect(promptOptions?.defaultText ?? '').toBe('');
  });

  test('a pasted allowlisted URL is accepted and persisted verbatim', async () => {
    respond = pastes('https://elya---circles.local:3000');
    await showEnvSwitcher();
    expect(currentOverride()).toBe('https://elya---circles.local:3000');
  });

  test('a pasted preview/dev URL with a port + path survives intact', async () => {
    respond = pastes('https://elya---circles.local:3000/lobby');
    await showEnvSwitcher();
    expect(currentOverride()).toBe('https://elya---circles.local:3000/lobby');
  });

  test('a pasted NON-allowlisted URL is still rejected (validation not weakened)', async () => {
    respond = pastes('https://evil.example.com');
    await showEnvSwitcher();
    expect(currentOverride()).toBe('');
  });

  test('typing still works: a hand-typed allowlisted URL is accepted', async () => {
    respond = () => 'https://lab.agf.circlesup.com'; // user types the full URL into the empty field
    await showEnvSwitcher();
    expect(currentOverride()).toBe('https://lab.agf.circlesup.com');
  });
});
