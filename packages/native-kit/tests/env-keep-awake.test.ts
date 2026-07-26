/**
 * Keep-awake gated on the effective BACKEND, not the build.
 *
 * The shell used to disable the iOS idle timer only when `SHELL_CONFIG.debug` was set — a BUILD-TIME fact
 * that misses the case that matters: a RELEASE binary (`debug:false`) whose env-switcher is pointed at lab
 * auto-locks mid-test. The signal is now `isNonDefaultOverride()` — the SAME predicate the amber env banner
 * uses — OR'd with `debug`.
 *
 * These drive the REAL code path (`showEnvSwitcher` → `applySwitch` → `refreshEnvKeepAwake` → the native
 * write) and observe the REAL consumer surface: `UIApplication.sharedApplication.idleTimerDisabled`.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';

const store: Record<string, string> = {};
let actionResult = '';

// The native surface under test — the iOS idle timer the shell actually writes.
const UIApplicationStub = { sharedApplication: { idleTimerDisabled: false } };
(globalThis as any).UIApplication = UIApplicationStub;

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
    prompt: async () => ({ result: false, text: '' }),
  },
  Utils: { dispatchToMainThread: (fn: () => void) => fn() },
  Application: { on: () => {}, suspendEvent: 's', resumeEvent: 'r', android: undefined },
  Connectivity: { startMonitoring: () => {} },
  isAndroid: false,
  isIOS: true,
}));

const shell = {
  SHELL_CONFIG: {
    loader: 'server',
    debug: false, // RELEASE build — the case the old build-type gate missed
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
// env-switcher imports the banner; stub it so no native UI is built (the banner has its own tests).
mock.module('../../../runtime/app/shell/env-banner', () => ({
  refreshEnvBanner: () => {},
  showEnvBannerIfActive: () => {},
  hideEnvBanner: () => {},
}));

const envSwitcher = await import('../../../runtime/app/shell/env-switcher');
const keepAwake = await import('../../../runtime/app/shell/env-keepawake');

const awake = () => UIApplicationStub.sharedApplication.idleTimerDisabled;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  UIApplicationStub.sharedApplication.idleTimerDisabled = false;
  shell.SHELL_CONFIG.debug = false;
  shell.SHELL_CONFIG.loader = 'server';
  (shell.SHELL_CONFIG.envSwitcher as any).enabled = true;
});

describe('keep-awake follows the effective backend, not the build type', () => {
  test('RELEASE build on the DEFAULT env → screen behaves normally (a real user)', () => {
    keepAwake.refreshEnvKeepAwake();
    expect(keepAwake.shouldKeepAwake()).toBe(false);
    expect(awake()).toBe(false);
  });

  test('RELEASE build switched to Lab in-session → screen kept awake', async () => {
    actionResult = 'Lab';
    await envSwitcher.showEnvSwitcher();
    expect(awake()).toBe(true); // fails without the refreshEnvKeepAwake() wiring in applySwitch
  });

  test('boot with a persisted override (relaunch straight into lab) → kept awake', () => {
    store['kit:serverUrlOverride'] = JSON.stringify('https://lab.agf.circlesup.com');
    keepAwake.refreshEnvKeepAwake();
    expect(awake()).toBe(true);
  });

  test('reset to default in-session → wake lock CLEARED without a relaunch', async () => {
    store['kit:serverUrlOverride'] = JSON.stringify('https://lab.agf.circlesup.com');
    keepAwake.refreshEnvKeepAwake();
    expect(awake()).toBe(true); // start switched + awake
    actionResult = 'Reset to default';
    await envSwitcher.showEnvSwitcher();
    expect(awake()).toBe(false);
  });

  test('switching to the preset that EQUALS the build default is a reset → not awake', async () => {
    store['kit:serverUrlOverride'] = JSON.stringify('https://lab.agf.circlesup.com');
    keepAwake.refreshEnvKeepAwake();
    actionResult = 'Prod'; // Prod.url === SHELL_CONFIG.serverUrl → applySwitch CLEARS the override
    await envSwitcher.showEnvSwitcher();
    expect(awake()).toBe(false);
  });

  test('debug build on the default env → still awake (dev/inspect loop keeps its old behaviour)', () => {
    shell.SHELL_CONFIG.debug = true;
    keepAwake.refreshEnvKeepAwake();
    expect(keepAwake.shouldKeepAwake()).toBe(true);
    expect(awake()).toBe(true);
  });

  test('reconcile is idempotent — a second call holds the state', () => {
    store['kit:serverUrlOverride'] = JSON.stringify('https://lab.agf.circlesup.com');
    keepAwake.refreshEnvKeepAwake();
    keepAwake.refreshEnvKeepAwake();
    expect(awake()).toBe(true);
  });
});

describe('boot/resume re-assert (reassertEnvKeepAwake)', () => {
  test('resume on lab re-asserts the lock (Android drops the flag on Activity recreation)', () => {
    store['kit:serverUrlOverride'] = JSON.stringify('https://lab.agf.circlesup.com');
    UIApplicationStub.sharedApplication.idleTimerDisabled = false; // simulate the platform dropping it
    keepAwake.reassertEnvKeepAwake();
    expect(awake()).toBe(true);
  });

  test("resume on the DEFAULT env must NOT clobber the app's own kit.ui.keepAwake(true)", () => {
    // The hosted app holds the screen on itself via the public `ui.keepAwake` bridge API (e.g. video).
    UIApplicationStub.sharedApplication.idleTimerDisabled = true;
    keepAwake.reassertEnvKeepAwake(); // default env → wants false, but must never WRITE false
    expect(awake()).toBe(true);
  });
});

describe('inert where the env-switcher does not apply', () => {
  test("loader:'app' (isEnvSwitcherEnabled false) → no-op, no crash, never awake", () => {
    shell.SHELL_CONFIG.loader = 'app';
    store['kit:serverUrlOverride'] = JSON.stringify('https://lab.agf.circlesup.com'); // stale key ignored
    expect(() => keepAwake.refreshEnvKeepAwake()).not.toThrow();
    expect(keepAwake.shouldKeepAwake()).toBe(false);
    expect(awake()).toBe(false);
  });

  test('envSwitcher disabled (prod fork) → never awake even with a persisted override', () => {
    (shell.SHELL_CONFIG.envSwitcher as any).enabled = false;
    store['kit:serverUrlOverride'] = JSON.stringify('https://lab.agf.circlesup.com');
    keepAwake.refreshEnvKeepAwake();
    expect(keepAwake.shouldKeepAwake()).toBe(false);
    expect(awake()).toBe(false);
  });
});
