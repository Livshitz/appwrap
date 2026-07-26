/**
 * In-session banner refresh (Fix 2).
 *
 * The env banner only rendered on relaunch (`showEnvBannerIfActive`); after an in-session
 * `applySwitch`/reset the WebView reloaded but the banner kept its stale label (or stayed visible after a
 * reset). Fix: `applySwitch` now calls `refreshEnvBanner()` AFTER persisting/clearing the override, so the
 * banner reflects the new env on a switch and hides on a reset. This proves the WIRING at the real call
 * site (`showEnvSwitcher` → `applySwitch` → `refreshEnvBanner`) and that refresh reads the NEW override.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store: Record<string, string> = {};
let confirmResult = true;
let actionResult = '';
const refreshCalls: string[] = []; // records the currentOverride() seen at each refresh

mock.module('@nativescript/core', () => ({
  ApplicationSettings: {
    getString: (k: string, d = '') => (k in store ? store[k] : d),
    setString: (k: string, v: string) => { store[k] = v; },
    remove: (k: string) => { delete store[k]; },
  },
  Dialogs: {
    confirm: async () => confirmResult,
    action: async () => actionResult,
    alert: async () => undefined,
    prompt: async () => ({ result: false, text: '' }),
  },
  Utils: { dispatchToMainThread: (fn: () => void) => fn() },
  Application: { on: () => {}, suspendEvent: 's', resumeEvent: 'r', orientationChangedEvent: 'o', android: {} },
  Connectivity: { startMonitoring: () => {} },
  isAndroid: false,
  isIOS: false,
}));

const shell = {
  SHELL_CONFIG: {
    loader: 'server',
    serverUrl: 'https://agf.circlesup.com',
    envSwitcher: {
      enabled: true,
      envs: [
        { label: 'Prod', url: 'https://agf.circlesup.com' },
        { label: 'Lab', url: 'https://lab.agf.circlesup.com' },
      ],
      allowPattern: '^https://lab\\.agf\\.circlesup\\.com$',
    },
  },
};
mock.module('../../../runtime/app/shell/config', () => shell);
mock.module('../../../runtime/app/shell/bridge', () => ({ bridge: { getWebView: () => null } }));

// Import the REAL env-switcher (currentOverride) so the spy records real persisted state, but stub the
// banner module (env-switcher imports it) so we observe that refreshEnvBanner is invoked and what it sees.
let currentOverrideRef: () => string;
mock.module('../../../runtime/app/shell/env-banner', () => ({
  refreshEnvBanner: () => refreshCalls.push(currentOverrideRef()),
  showEnvBannerIfActive: () => {},
  hideEnvBanner: () => {},
}));

const envSwitcher = await import('../../../runtime/app/shell/env-switcher');
currentOverrideRef = envSwitcher.currentOverride;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  refreshCalls.length = 0;
  confirmResult = true;
});

describe('applySwitch re-renders/hides the banner in-session (Fix 2)', () => {
  test('switch to a preset → refreshEnvBanner called, sees the NEW override', async () => {
    actionResult = 'Lab';
    await envSwitcher.showEnvSwitcher();
    expect(refreshCalls).toEqual(['https://lab.agf.circlesup.com']); // banner refreshed with new env
    expect(envSwitcher.currentOverride()).toBe('https://lab.agf.circlesup.com');
  });

  test('reset to default → refreshEnvBanner called, sees NO override (banner will hide)', async () => {
    store['kit:serverUrlOverride'] = JSON.stringify('https://lab.agf.circlesup.com'); // start switched
    actionResult = 'Reset to default';
    await envSwitcher.showEnvSwitcher();
    expect(refreshCalls).toEqual(['']); // empty override → refreshEnvBanner's hide path
    expect(envSwitcher.currentOverride()).toBe('');
  });

  test('switch to the preset that equals the build default → override CLEARED, non-default false', async () => {
    store['kit:serverUrlOverride'] = JSON.stringify('https://lab.agf.circlesup.com'); // start switched away
    actionResult = 'Prod'; // Prod.url === SHELL_CONFIG.serverUrl
    await envSwitcher.showEnvSwitcher();
    expect(refreshCalls).toEqual(['']); // cleared → refreshEnvBanner sees no override → banner hides
    expect(envSwitcher.currentOverride()).toBe('');
    expect(envSwitcher.isNonDefaultOverride()).toBe(false);
  });

  test('isNonDefaultOverride true only for a genuinely different host', async () => {
    actionResult = 'Lab';
    await envSwitcher.showEnvSwitcher();
    expect(envSwitcher.isNonDefaultOverride()).toBe(true);
  });

  test('cancelled confirm → override unchanged AND banner NOT refreshed', async () => {
    confirmResult = false;
    actionResult = 'Lab';
    await envSwitcher.showEnvSwitcher();
    expect(refreshCalls).toEqual([]);
    expect(envSwitcher.currentOverride()).toBe('');
  });
});
