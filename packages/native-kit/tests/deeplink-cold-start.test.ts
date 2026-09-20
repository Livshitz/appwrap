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
  Http: { request: async () => ({ content: null }) },
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
// The iOS notification-tap entry point shares this same cold-start gate.
const { onRemoteMessage } = await import('../../../runtime/app/shell/handlers-push');

/** An APNs userInfo as the server sends it: the tap's route lives in the custom (non-aps) keys. */
const TAP_USER_INFO = { aps: { alert: { title: 'Para', body: 'Social proposal' } }, route: '/chat/conv_x', convId: 'conv_x' };

beforeEach(() => {
  emitted.length = 0;
  // Reset module-level buffer/pwaReady state by draining anything left over.
  events.consumePendingDeepLink();
});

describe('cold-start deep-link delivery', () => {
  // MUST also run before onPwaHandshake() — same module-level `pwaReady`.
  test('cold start: an iOS notification tap is buffered like a deep link, not emitted', () => {
    // The UNUserNotificationCenter delegate fires while the WebView is still loading the bundle.
    // Emitting `push.tap` there reaches no listener and the route is lost, so the app opens on its
    // home screen instead of the conversation. It must go through the gate (events.onPushTap).
    onRemoteMessage(TAP_USER_INFO, true);
    expect(emitted).toHaveLength(0);
  });

  // A non-tap remote message is NOT route-shaped and must keep its immediate delivery.
  test('a non-tap remote message is emitted immediately, gate or no gate', () => {
    onRemoteMessage(TAP_USER_INFO, false);
    expect(emitted.map((e) => e.event)).toEqual(['push.message']);
    emitted.length = 0;
  });

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

  // Closes the loop on the FIRST test: that tap is still parked in the buffer. The handshake above
  // scheduled its flush (~500ms, deliberately after listener install), so waiting past it here both
  // proves the route survives the cold start AND drains the timer before the file tears its mocks
  // down. Must stay last.
  test('the buffered cold-start tap is flushed after the handshake, route intact', async () => {
    await new Promise((r) => setTimeout(r, 600));
    const tap = emitted.find((e) => e.event === 'push.tap');
    expect((tap?.payload as { data: Record<string, unknown> }).data.route).toBe('/chat/conv_x');
  });
});
