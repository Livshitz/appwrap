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
