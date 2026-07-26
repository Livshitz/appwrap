/**
 * Cold-start deep-link delivery seam (runtime/app/shell/events.ts).
 *
 * The pure buffering logic is testable without a device: a link that arrives BEFORE the PWA
 * handshake is buffered and must be handed back via `consumePendingDeepLink()` (read-once) — to be
 * embedded in the handshake response so the page routes before first paint — and must NOT also be
 * flushed as a `deeplink.open` event (that was the ~500ms-delayed `/home`-flash path we removed).
 * A link that arrives AFTER the handshake (warm) still emits the event.
 *
 * events.ts imports `@nativescript/core` + `./handlers-extended`; both are mocked at the module
 * boundary so the seam runs in-process.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const emitted: Array<{ event: string; payload: unknown }> = [];

mock.module('@nativescript/core', () => ({
  Application: { on: () => {}, suspendEvent: 's', resumeEvent: 'r', orientationChangedEvent: 'o', android: {} },
  Connectivity: { startMonitoring: () => {} },
  isAndroid: false,
  // Superset shape — bun shares the runtime-module cache across files in a dir run, so every
  // @nativescript/core mock must expose the same named exports the runtime modules import.
  ApplicationSettings: { getString: (_k: string, d = '') => d, setString: () => {}, remove: () => {} },
  Dialogs: { confirm: async () => true, action: async () => '', alert: async () => undefined, prompt: async () => ({ result: false, text: '' }) },
  Utils: { dispatchToMainThread: (fn: () => void) => fn() },
  isIOS: false,
  WebView: class {},
}));
mock.module('../../../runtime/app/shell/bridge', () => ({
  bridge: { emit: (event: string, payload: unknown) => emitted.push({ event, payload }) },
}));
mock.module('../../../runtime/app/shell/handlers-extended', () => ({
  connectivityStatus: () => ({ type: 'wifi', online: true }),
}));

// Imported AFTER the mocks are registered so events.ts resolves the stubs.
const events = await import('../../../runtime/app/shell/events');

beforeEach(() => {
  emitted.length = 0;
  // Reset module-level buffer/pwaReady state by draining anything left over.
  events.consumePendingDeepLink();
});

describe('cold-start deep-link delivery', () => {
  // MUST run before any test that calls onPwaHandshake() — pwaReady is module state and only cold
  // (pre-handshake) links are buffered.
  test('cold start: a transformer registered AFTER ingestion still applies at consume (iOS share ordering)', () => {
    // iOS cold launch: didFinishLaunching ingests the share link BEFORE main-page init registers the
    // shareTarget transformer (gfile= → file=). The buffered URL must be transformed when consumed.
    events.onDeepLink('hellowrap://share?text=hi&gfile=a.png'); // ingested raw — no transformer yet
    events.setDeepLinkTransformer((url) =>
      url.includes('gfile=') ? url.replace('gfile=', 'file=appwrap-share%2F') : url
    );
    expect(events.consumePendingDeepLink()).toBe('hellowrap://share?text=hi&file=appwrap-share%2Fa.png');
    events.setDeepLinkTransformer(null);
  });

  test('a link before handshake is buffered, returned by consumePendingDeepLink, and NOT flushed as an event', () => {
    events.onDeepLink('hellowrap://item/7');
    // Nothing emitted yet — it is buffered for handshake-embedded delivery.
    expect(emitted).toHaveLength(0);

    // The handshake handler drains it (read-once) to put it in the response.
    expect(events.consumePendingDeepLink()).toBe('hellowrap://item/7');
    // Drained — a second read is empty (no duplicate delivery).
    expect(events.consumePendingDeepLink()).toBeNull();

    // The handshake completes: the cold link must NOT be re-emitted as an event (no /home flash path).
    events.onPwaHandshake();
    expect(emitted.filter((e) => e.event === 'deeplink.open')).toHaveLength(0);
  });

  test('a warm link (after handshake) emits deeplink.open immediately and is not buffered', () => {
    events.onPwaHandshake(); // PWA is ready
    events.onDeepLink('hellowrap://profile');
    expect(emitted).toEqual([{ event: 'deeplink.open', payload: { url: 'hellowrap://profile' } }]);
    expect(events.consumePendingDeepLink()).toBeNull(); // nothing buffered
  });
});
