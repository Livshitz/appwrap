/**
 * Env-switcher security hardening (runtime/app/shell/server-url.ts).
 *
 * Fix 1(b): `effectiveServerUrl()` is read at every boot/reload — but the persisted `serverUrlOverride`
 * key is a bridge seam ANY page JS can write via `kit.storage.set`, not only the native menu. So the
 * READ side must re-validate the stored override against the SAME allowlist the switcher uses: a declared
 * preset is implicitly trusted; anything else must match `allowPattern`; a stored override matching
 * NEITHER is IGNORED and the shell falls back to the build-time `serverUrl`. Proven in-process by mocking
 * `@nativescript/core` (ApplicationSettings store) + `./config` (SHELL_CONFIG).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store: Record<string, string> = {};

// Superset shape (bun shares the runtime-module cache across files in a dir run, so every
// @nativescript/core mock must expose the same named exports the runtime modules import).
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

const { effectiveServerUrl, isOverrideAllowed, OVERRIDE_KEY } = await import('../../../runtime/app/shell/server-url');

/** Simulate a page JS write through the kit.storage seam: JSON.stringify under the namespaced key. */
function persistOverride(url: string): void {
  store[OVERRIDE_KEY] = JSON.stringify(url);
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  shell.SHELL_CONFIG.loader = 'server';
  shell.SHELL_CONFIG.envSwitcher.enabled = true;
});

describe('effectiveServerUrl re-validates the persisted override (Fix 1b)', () => {
  test('no override → build-time serverUrl', () => {
    expect(effectiveServerUrl()).toBe(BUILD_URL);
  });

  test('override = a declared PRESET → honored (implicitly trusted)', () => {
    persistOverride('https://lab.agf.circlesup.com');
    expect(effectiveServerUrl()).toBe('https://lab.agf.circlesup.com');
  });

  test('override = an ALLOWLISTED url (matches allowPattern) → honored', () => {
    persistOverride('https://agf-pr-123.vercel.app');
    expect(effectiveServerUrl()).toBe('https://agf-pr-123.vercel.app');
  });

  test('SECURITY: override matching NEITHER preset NOR allowPattern → IGNORED, falls back to build serverUrl', () => {
    // A compromised page persists an attacker origin directly through kit.storage.
    persistOverride('https://evil.example.com');
    expect(effectiveServerUrl()).toBe(BUILD_URL); // NOT evil.example.com
  });

  test('SECURITY: substring/partial match on the preview pattern is rejected (full-string only)', () => {
    persistOverride('https://agf-pr-123.vercel.app.evil.com');
    expect(effectiveServerUrl()).toBe(BUILD_URL);
    expect(isOverrideAllowed('https://agf-pr-123.vercel.app.evil.com')).toBe(false);
  });

  test('disabled switcher → override ignored regardless of allowlist', () => {
    shell.SHELL_CONFIG.envSwitcher.enabled = false;
    persistOverride('https://lab.agf.circlesup.com');
    expect(effectiveServerUrl()).toBe(BUILD_URL);
  });

  test('isOverrideAllowed: preset trusted, allowlisted trusted, arbitrary denied', () => {
    expect(isOverrideAllowed('https://agf.circlesup.com')).toBe(true);        // preset
    expect(isOverrideAllowed('https://agf-x.vercel.app')).toBe(true);         // allowlist
    expect(isOverrideAllowed('https://evil.example.com')).toBe(false);        // neither
  });
});
