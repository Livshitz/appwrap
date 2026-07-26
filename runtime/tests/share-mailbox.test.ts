/**
 * iOS shareTarget App-Group mailbox — the durable extension→host hand-off (modern iOS blocks a share
 * extension from launching its host via `openURL:`, so payloads are persisted and DRAINED by the host
 * on cold launch + every resume). Contract under test: exactly-once delivery (clear-before-deliver),
 * crash-safety (nothing lost while no drain ran), cold→resume sequencing, and garbage filtering.
 */
import { describe, expect, test } from 'bun:test';
import { drainShareMailbox } from '../app/shell/share-mailbox';

/** In-memory stand-in for the App-Group UserDefaults mailbox the extension appends to. */
function fakeStore(initial: string[] = []) {
  let box = [...initial];
  return {
    box: () => box,
    push: (u: string) => box.push(u), // what ShareViewController.enqueueMailbox does
    store: {
      read: () => [...box],
      clear: () => { box = []; },
    },
  };
}

describe('drainShareMailbox — exactly-once, crash-safe delivery', () => {
  test('cold launch: delivers every pending share URL in order, then the mailbox is empty (read-once)', () => {
    const { store, box } = fakeStore(['app://share?text=a', 'app://share?text=b']);
    const got: string[] = [];
    expect(drainShareMailbox(store, (u) => got.push(u))).toBe(2);
    expect(got).toEqual(['app://share?text=a', 'app://share?text=b']);
    expect(box()).toEqual([]);
    // A second drain right after (e.g. resumeEvent firing just after the cold-launch drain) delivers NOTHING.
    expect(drainShareMailbox(store, (u) => got.push(u))).toBe(0);
    expect(got).toHaveLength(2);
  });

  test('resume: a share enqueued while backgrounded is picked up by the next foreground drain, once', () => {
    const { store, push } = fakeStore();
    const got: string[] = [];
    expect(drainShareMailbox(store, (u) => got.push(u))).toBe(0); // cold launch, nothing shared yet
    push('app://share?text=warm&gfile=pic.png'); // extension writes while app is backgrounded
    expect(drainShareMailbox(store, (u) => got.push(u))).toBe(1); // foreground → resume drain
    expect(drainShareMailbox(store, (u) => got.push(u))).toBe(0); // next resume: already consumed
    expect(got).toEqual(['app://share?text=warm&gfile=pic.png']);
  });

  test('clears BEFORE delivering — a re-entrant drain during delivery cannot double-deliver', () => {
    const { store } = fakeStore(['app://share?text=x']);
    const got: string[] = [];
    drainShareMailbox(store, (u) => {
      got.push(u);
      drainShareMailbox(store, (u2) => got.push(u2)); // overlapping drain mid-delivery
    });
    expect(got).toEqual(['app://share?text=x']);
  });

  test('crash-safety: an entry written by the extension persists until a drain actually runs', () => {
    const { store, box } = fakeStore(['app://share?text=kept']);
    // Host crashed (or was never opened) after the extension wrote — nothing consumed the store.
    expect(box()).toEqual(['app://share?text=kept']); // still there on the next launch/foreground
    const got: string[] = [];
    drainShareMailbox(store, (u) => got.push(u));
    expect(got).toEqual(['app://share?text=kept']);
  });

  test('non-share / garbage entries are dropped but still cleared', () => {
    const { store, box } = fakeStore(['not a url', 'app://other?x=1', 'app://share?text=ok']);
    const got: string[] = [];
    expect(drainShareMailbox(store, (u) => got.push(u))).toBe(1);
    expect(got).toEqual(['app://share?text=ok']);
    expect(box()).toEqual([]);
  });

  test('empty mailbox: no clear, no delivery', () => {
    let cleared = false;
    const n = drainShareMailbox({ read: () => [], clear: () => { cleared = true; } }, () => { throw new Error('must not deliver'); });
    expect(n).toBe(0);
    expect(cleared).toBe(false);
  });
});
