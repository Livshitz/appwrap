/**
 * PURE iOS shareTarget mailbox-drain logic (no NativeScript imports; bun-tested — mirrors
 * geo-auth.ts/notif-identity.ts: the semantics live here, handlers-share-target.ts only does the
 * NSUserDefaults plumbing).
 *
 * WHY a mailbox: modern iOS silently blocks a share extension's responder-chain `openURL:` — a share
 * extension may NOT launch its host app. So the generated `AppwrapShare` extension durably appends
 * the share URL (`<scheme>://share?…`) to an App-Group UserDefaults string array under MAILBOX_KEY,
 * and the HOST drains it on cold launch and on every foreground/resume. Read-once: the drain clears
 * the mailbox BEFORE delivering, so overlapping drains can never double-deliver; crash-safety: the
 * extension's write persists until a drain actually runs, and one runs on every foreground.
 */

/** App-Group UserDefaults key the extension appends to (see ShareViewController.swift). */
export const MAILBOX_KEY = 'appwrap-share-mailbox';

/** Minimal seam over the App-Group UserDefaults mailbox — injectable for tests. */
export interface ShareMailboxStore {
  read(): string[];
  clear(): void;
}

/**
 * Drain the share mailbox: read all pending share URLs, CLEAR first (exactly-once), then deliver
 * each through `deliver` (the normal deep-link ingress: cold launches buffer into the handshake
 * `deepLink`, warm apps get `deeplink.open`). Non-share/garbage entries are dropped. Returns the
 * number of URLs delivered.
 */
export function drainShareMailbox(store: ShareMailboxStore, deliver: (url: string) => void): number {
  const urls = store.read();
  if (!urls.length) return 0;
  store.clear(); // read-once: clear BEFORE delivering so re-entry during delivery can't duplicate
  let delivered = 0;
  for (const u of urls) {
    if (typeof u !== 'string' || !u.includes('://share?')) continue;
    delivered++;
    deliver(u);
  }
  return delivered;
}
