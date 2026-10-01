/**
 * Env-switcher URL params (`envSwitcher.params`): a picked value persists and every load URL carries
 * `?<key>=<value>`; "default" clears it; undeclared/page-written keys are ignored; options come from a
 * JSON URL resolved against the ACTIVE env (override) and fall back to the static list on failure.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store: Record<string, string> = {};
const http = { calls: [] as string[], respond: (_url: string): any => ({ statusCode: 200, content: { toJSON: () => ({}) } }) };

mock.module('@nativescript/core', () => ({
  Http: { request: async (o: { url: string }) => { http.calls.push(o.url); return http.respond(o.url); } },
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

const shell = {
  SHELL_CONFIG: {
    loader: 'server' as 'server' | 'app' | 'file',
    serverUrl: 'https://agf.example.com',
    envSwitcher: {
      enabled: true,
      envs: [{ label: 'Lab', url: 'https://lab.example.com' }],
      allowPattern: '',
      params: [{ key: 'segment', label: 'Segment', options: [] as string[], optionsUrl: '/api/v1/segments/names', optionsPath: 'names' }],
    },
  },
};
mock.module('../../../runtime/app/shell/config', () => shell);

const { effectiveServerUrl, OVERRIDE_KEY, URL_PARAMS_KEY } = await import('../../../runtime/app/shell/server-url');
const { loadParamOptions, setUrlParam, extractOptions, paramMenuLabel } = await import('../../../runtime/app/shell/url-params');
const seg = shell.SHELL_CONFIG.envSwitcher.params[0];

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  http.calls = [];
  shell.SHELL_CONFIG.envSwitcher.enabled = true;
  shell.SHELL_CONFIG.loader = 'server';
});

describe('url params on the load URL', () => {
  test('no pick → plain URL; pick → ?segment=; default → cleared', () => {
    expect(effectiveServerUrl()).toBe('https://agf.example.com');
    setUrlParam('segment', 'senior');
    expect(effectiveServerUrl()).toBe('https://agf.example.com?segment=senior');
    expect(paramMenuLabel(seg)).toBe('Segment: senior');
    setUrlParam('segment', 'default');
    expect(effectiveServerUrl()).toBe('https://agf.example.com');
    expect(paramMenuLabel(seg)).toBe('Segment: default');
  });
  test('applies on top of an env override, value encoded', () => {
    store[OVERRIDE_KEY] = JSON.stringify('https://lab.example.com');
    setUrlParam('segment', 'a b&c');
    expect(effectiveServerUrl()).toBe('https://lab.example.com?segment=a%20b%26c');
  });
  test('undeclared keys (page-written) ignored; disabled switcher ignores all', () => {
    store[URL_PARAMS_KEY] = JSON.stringify({ evil: 'x', segment: 'senior' });
    expect(effectiveServerUrl()).toBe('https://agf.example.com?segment=senior');
    shell.SHELL_CONFIG.envSwitcher.enabled = false;
    expect(effectiveServerUrl()).toBe('https://agf.example.com');
  });
});

describe('options source', () => {
  test('fetched relative to the ACTIVE env, default first', async () => {
    store[OVERRIDE_KEY] = JSON.stringify('https://lab.example.com');
    http.respond = () => ({ statusCode: 200, content: { toJSON: () => ({ success: true, names: ['circles_internal', 'senior'] }) } });
    expect(await loadParamOptions(seg)).toEqual(['default', 'circles_internal', 'senior']);
    expect(http.calls).toEqual(['https://lab.example.com/api/v1/segments/names']);
  });
  test('fetch failure → falls back to static list', async () => {
    http.respond = () => ({ statusCode: 500, content: { toJSON: () => ({}) } });
    expect(await loadParamOptions({ ...seg, options: ['x'] })).toEqual(['default', 'x']);
  });
  test('extractOptions: object → keys, array → strings', () => {
    expect(extractOptions({ a: { b: 1, c: 2 } }, 'a')).toEqual(['b', 'c']);
    expect(extractOptions(['x', 3, '', 'y'])).toEqual(['x', 'y']);
  });
});
