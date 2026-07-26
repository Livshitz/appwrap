/**
 * Env-switcher DEEP LINK security (runtime/app/shell/env-switcher.ts `decideEnvDeepLink`).
 *
 * Phase 2: launching from `<scheme>://env?url=<encoded-url>` offers to switch the shell to that env, so a
 * PR-preview link can be shared and auto-open the app on that env. This is the PURE parse+allowlist
 * DECISION (no dialogs / no WebView) — mirrors env-switcher-security.test.ts. The target URL must pass the
 * SAME `isUrlAllowed` gate as the "Other" custom URL (anchored allowPattern, default-deny): allowed →
 * switch intent; disallowed → rejected (never switch); malformed / feature-disabled → ignored.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store: Record<string, string> = {};

// Superset @nativescript/core mock (bun shares the module cache across files in a dir run, so every mock
// must expose the same named exports the imported runtime modules pull — incl. `WebView` for bridge's
// CustomWebView base class, reached via env-switcher → bridge → custom-webview).
mock.module('@nativescript/core', () => ({
  ApplicationSettings: {
    getString: (k: string, d = '') => (k in store ? store[k] : d),
    setString: (k: string, v: string) => { store[k] = v; },
    remove: (k: string) => { delete store[k]; },
  },
  Dialogs: { confirm: async () => true, action: async () => '', alert: async () => undefined, prompt: async () => ({ result: false, text: '' }) },
  Utils: { dispatchToMainThread: (fn: () => void) => fn() },
  Application: { on: () => {}, suspendEvent: 's', resumeEvent: 'r', orientationChangedEvent: 'o', android: {} },
  Connectivity: { startMonitoring: () => {} },
  WebView: class {},
  isAndroid: false,
  isIOS: false,
}));

const BUILD_URL = 'https://agf.circlesup.com';
const shell = {
  SHELL_CONFIG: {
    loader: 'server' as 'server' | 'app' | 'file',
    serverUrl: BUILD_URL,
    envSwitcher: {
      enabled: true,
      envs: [
        { label: 'Prod', url: 'https://agf.circlesup.com' },
        { label: 'Lab', url: 'https://lab.agf.circlesup.com' },
      ],
      // anchored allowlist for vercel-preview URLs only
      allowPattern: '^https://agf-[a-z0-9-]+\\.vercel\\.app$',
    },
  },
};
mock.module('../../../runtime/app/shell/config', () => shell);

const { decideEnvDeepLink, isEnvDeepLink } = await import('../../../runtime/app/shell/env-switcher');

/** Build a `circles://env?url=<encoded>` deep link. */
function link(target: string, scheme = 'circles'): string {
  return `${scheme}://env?url=${encodeURIComponent(target)}`;
}

const LAB_URL = 'https://lab.agf.circlesup.com';
const PROD_URL = 'https://agf.circlesup.com';

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  shell.SHELL_CONFIG.loader = 'server';
  shell.SHELL_CONFIG.envSwitcher.enabled = true;
});

describe('decideEnvDeepLink — parse + allowlist decision', () => {
  test('allowlisted preview URL → switch intent with the decoded target', () => {
    expect(decideEnvDeepLink(link('https://agf-pr-123.vercel.app'))).toEqual({
      action: 'switch',
      url: 'https://agf-pr-123.vercel.app',
    });
  });

  test('a declared preset URL passed by deep link is NOT auto-trusted — must match allowPattern (isUrlAllowed)', () => {
    // Presets are reachable from the menu; the deep-link gate is deliberately the strict allowPattern.
    expect(decideEnvDeepLink(link('https://lab.agf.circlesup.com'))).toEqual({
      action: 'rejected',
      url: 'https://lab.agf.circlesup.com',
    });
  });

  test('SECURITY: disallowed target (not preset, not allowPattern) → rejected, NEVER switch', () => {
    expect(decideEnvDeepLink(link('https://evil.example.com'))).toEqual({
      action: 'rejected',
      url: 'https://evil.example.com',
    });
  });

  test('SECURITY: substring/suffix attack on the preview pattern → rejected (full-string match only)', () => {
    expect(decideEnvDeepLink(link('https://agf-pr-123.vercel.app.evil.com')).action).toBe('rejected');
  });

  test('SECURITY: non-http(s) scheme (javascript:) → rejected', () => {
    expect(decideEnvDeepLink(link('javascript:alert(1)')).action).toBe('rejected');
  });

  test('malformed: no `url` param → ignored', () => {
    expect(decideEnvDeepLink('circles://env').action).toBe('ignored');
    expect(decideEnvDeepLink('circles://env?foo=bar').action).toBe('ignored');
  });

  test('malformed: undecodable percent-encoding in `url` → ignored', () => {
    expect(decideEnvDeepLink('circles://env?url=%E0%A4%A').action).toBe('ignored');
  });

  test('not an env link (host !== "env") → ignored', () => {
    expect(decideEnvDeepLink('circles://home?url=' + encodeURIComponent('https://agf-x.vercel.app')).action).toBe('ignored');
    expect(decideEnvDeepLink('https://agf.circlesup.com/env?url=x').action).toBe('ignored');
  });

  test('feature disabled → ignored even for an otherwise-allowlisted target', () => {
    shell.SHELL_CONFIG.envSwitcher.enabled = false;
    expect(decideEnvDeepLink(link('https://agf-pr-123.vercel.app')).action).toBe('ignored');
  });
});

describe('decideEnvDeepLink — `?to=<name>` preset-by-name (TRUSTED, bypasses allowlist)', () => {
  test('to=lab → switch to the Lab preset url (bypasses allowPattern)', () => {
    expect(decideEnvDeepLink('circles://env?to=lab')).toEqual({ action: 'switch', url: LAB_URL });
  });

  test('to=LAB → same (case-insensitive by label)', () => {
    expect(decideEnvDeepLink('circles://env?to=LAB')).toEqual({ action: 'switch', url: LAB_URL });
  });

  test('to=Lab → same (mixed case)', () => {
    expect(decideEnvDeepLink('circles://env?to=Lab')).toEqual({ action: 'switch', url: LAB_URL });
  });

  test('to=prod → switch to the Prod preset url', () => {
    expect(decideEnvDeepLink('circles://env?to=prod')).toEqual({ action: 'switch', url: PROD_URL });
  });

  test('to=nonesuch (no matching preset) → rejected, NEVER switch, NEVER fall through', () => {
    expect(decideEnvDeepLink('circles://env?to=nonesuch')).toEqual({ action: 'rejected', url: 'nonesuch' });
  });

  test('env=lab alias → switch to the Lab preset url', () => {
    expect(decideEnvDeepLink('circles://env?env=lab')).toEqual({ action: 'switch', url: LAB_URL });
  });

  test('both to + env present → `to` wins', () => {
    expect(decideEnvDeepLink('circles://env?to=prod&env=lab')).toEqual({ action: 'switch', url: PROD_URL });
  });

  test('both to + url present → `to` (preset) takes precedence over url', () => {
    const l = `circles://env?to=lab&url=${encodeURIComponent('https://agf-pr-123.vercel.app')}`;
    expect(decideEnvDeepLink(l)).toEqual({ action: 'switch', url: LAB_URL });
  });

  test('both to (unknown) + url (allowlisted) → still rejected on `to`, never falls through to url', () => {
    const l = `circles://env?to=nope&url=${encodeURIComponent('https://agf-pr-123.vercel.app')}`;
    expect(decideEnvDeepLink(l)).toEqual({ action: 'rejected', url: 'nope' });
  });

  test('feature disabled → ignored even for a valid preset name', () => {
    shell.SHELL_CONFIG.envSwitcher.enabled = false;
    expect(decideEnvDeepLink('circles://env?to=lab').action).toBe('ignored');
  });

  test('regression: `?url=<allowlisted>` still switches (url path unchanged)', () => {
    expect(decideEnvDeepLink(link('https://agf-pr-123.vercel.app'))).toEqual({
      action: 'switch',
      url: 'https://agf-pr-123.vercel.app',
    });
  });

  test('regression: `?url=<not-allowlisted>` still rejected (url path stays allowlist-gated)', () => {
    expect(decideEnvDeepLink(link('https://evil.example.com'))).toEqual({
      action: 'rejected',
      url: 'https://evil.example.com',
    });
  });
});

describe('isEnvDeepLink — the consume signal events.ts uses', () => {
  test('env link + enabled → true (consumed, not forwarded to the PWA)', () => {
    expect(isEnvDeepLink('circles://env?url=x')).toBe(true);
  });
  test('env host is case-insensitive', () => {
    expect(isEnvDeepLink('circles://ENV?url=x')).toBe(true);
  });
  test('non-env deep link → false (flows to the normal PWA path)', () => {
    expect(isEnvDeepLink('circles://profile/42')).toBe(false);
  });
  test('feature disabled → false (inert; link falls through to the PWA)', () => {
    shell.SHELL_CONFIG.envSwitcher.enabled = false;
    expect(isEnvDeepLink('circles://env?url=x')).toBe(false);
  });
});
