/**
 * Debug-only dev-server cert-trust host scope (custom-webview.ios.ts / .android.ts).
 *
 * Fix 1(a): the cert-trust challenge handler used to scope the trusted host to
 * `hostOfUrl(effectiveServerUrl())` — but `effectiveServerUrl()` returns the user/persisted OVERRIDE, so a
 * switched (or maliciously-written) host would get its self-signed cert trusted → MITM. It must scope to
 * the BUILD-TIME `SHELL_CONFIG.serverUrl` host ONLY (the local dev server is always the build-time URL).
 *
 * The native delegate can't run in-process, so this proves the security-relevant DATA-SOURCE change two
 * ways: (1) behaviorally — the build host does NOT follow an active override, whereas `effectiveServerUrl`
 * (the old source) does; (2) structurally — both webview files now derive the allowed host from
 * SHELL_CONFIG.serverUrl and no longer import effectiveServerUrl.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const store: Record<string, string> = {};
// Superset shape — see the note in env-switcher-security.test.ts (shared runtime-module cache).
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

const BUILD_URL = 'https://192.168.1.50:3000';
const shell = {
  SHELL_CONFIG: {
    loader: 'server' as 'server' | 'app' | 'file',
    serverUrl: BUILD_URL,
    envSwitcher: {
      enabled: true,
      envs: [{ label: 'Lab', url: 'https://lab.agf.circlesup.com' }],
      allowPattern: '^https://lab\\.agf\\.circlesup\\.com$',
    },
  },
};
mock.module('../../../runtime/app/shell/config', () => shell);

const { effectiveServerUrl, OVERRIDE_KEY } = await import('../../../runtime/app/shell/server-url');

/** Same host extraction the webview `hostOfUrl` uses. */
function hostOfUrl(url: string): string {
  const afterScheme = String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = afterScheme.split(/[/?#]/)[0];
  return (authority.split('@').pop() || authority).toLowerCase();
}

const RUNTIME_SHELL = join(import.meta.dir, '../../../runtime/app/shell');

beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

describe('cert-trust host is pinned to the build-time serverUrl (Fix 1a)', () => {
  test('trusted host = build host, and does NOT follow an active (allowlisted) override', () => {
    // A legitimate in-session switch to Lab: effectiveServerUrl now points at lab...
    store[OVERRIDE_KEY] = JSON.stringify('https://lab.agf.circlesup.com');
    expect(effectiveServerUrl()).toBe('https://lab.agf.circlesup.com'); // the OLD trust source

    // ...but the cert-trust host (NEW source) stays the build-time dev-server host.
    const trustedHost = hostOfUrl(shell.SHELL_CONFIG.serverUrl);
    expect(trustedHost).toBe('192.168.1.50:3000');
    // The old source would have trusted the switched host's self-signed cert — the MITM hole:
    expect(hostOfUrl(effectiveServerUrl())).not.toBe(trustedHost);
  });

  test('structural: both webview files scope to SHELL_CONFIG.serverUrl and no longer import effectiveServerUrl', () => {
    for (const f of ['custom-webview.ios.ts', 'custom-webview.android.ts']) {
      const src = readFileSync(join(RUNTIME_SHELL, f), 'utf8');
      // Build-time source only. iOS uses its local `hostOfUrl`; Android uses the shared `hostOf`
      // (from env-switcher) — either way the allowed host derives from SHELL_CONFIG.serverUrl.
      expect(src).toMatch(/host[A-Za-z]*\(SHELL_CONFIG\.serverUrl\)/);
      expect(src).not.toContain("import { effectiveServerUrl } from './server-url'");
      // and the trust decision line must not read the override function (any host* helper)
      expect(src).not.toMatch(/host[A-Za-z]*\(effectiveServerUrl\(\)\)/);
    }
  });
});
