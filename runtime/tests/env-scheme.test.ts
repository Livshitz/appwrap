/**
 * `detectEnv()` / `envGlobalsJs()` surface the app's own custom URL scheme to the page as
 * `window.__APPWRAP__.scheme`. Contract: the key is present ONLY when `SHELL_CONFIG.urlScheme` is set,
 * and OMITTED (not `scheme:""`/undefined) when empty — for BOTH android and ios.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

// isAndroid is a getter over a mutable flag so both platform branches are exercised. Superset the
// named exports env.ts reaches (Application is only touched on the android branch's reduce-motion path,
// which throws-and-falls-back off-device — safe to stub minimally).
let androidFlag = false;
mock.module('@nativescript/core', () => ({
  Application: { android: {} },
  get isAndroid() { return androidFlag; },
  isIOS: false,
  WebView: class {},
  // Superset shape — bun shares the runtime-module cache across files in a dir run, so every
  // @nativescript/core mock must expose the same named exports the runtime modules import.
  ApplicationSettings: { getString: (_k: string, d = '') => d, setString: () => {}, remove: () => {} },
  Dialogs: { confirm: async () => true, action: async () => '', alert: async () => undefined, prompt: async () => ({ result: false, text: '' }) },
  Utils: { dispatchToMainThread: (fn: () => void) => fn() },
  Connectivity: { startMonitoring: () => {} },
}));

// Dynamic import AFTER mock.module so the stub is registered before env.ts pulls @nativescript/core
// (static imports hoist above mock.module and would load the real native module).
const { SHELL_CONFIG } = await import('../app/shell/config');
const { detectEnv, envGlobalsJs } = await import('../app/shell/env');

afterEach(() => { SHELL_CONFIG.urlScheme = ''; });

for (const platform of ['android', 'ios'] as const) {
  describe(`scheme surfacing — ${platform}`, () => {
    test('INCLUDES scheme when urlScheme is set', () => {
      androidFlag = platform === 'android';
      SHELL_CONFIG.urlScheme = 'demoapp';
      expect(detectEnv().scheme).toBe('demoapp');
      expect(envGlobalsJs()).toContain('"scheme":"demoapp"');
    });

    test('OMITS the scheme key when urlScheme is empty', () => {
      androidFlag = platform === 'android';
      SHELL_CONFIG.urlScheme = '';
      const env = detectEnv();
      expect('scheme' in env).toBe(false);
      // The injected snippet must carry no `scheme` key at all (not scheme:"" / scheme:undefined).
      expect(envGlobalsJs()).not.toContain('scheme');
    });
  });
}
