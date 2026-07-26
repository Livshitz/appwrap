import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

/** A payload shared INTO the app from the OS share sheet. */
export interface SharedPayload {
  /** Shared text / URL (Android EXTRA_TEXT). */
  text?: string;
  /** Share subject/title (Android EXTRA_SUBJECT), when the sender set one. */
  title?: string;
  /** Shared files (images), copied by the shell into the app cache — each entry is a path relative
   * to the cache root, readable via `kit.fs.read(p, { dir: 'cache', encoding: 'base64' })`. */
  files?: string[];
}

/**
 * Parse a shareTarget deep link (`<scheme>://share?text=…&title=…&file=…&file=…`) into a payload.
 * Returns null for any URL that isn't a share delivery — safe to feed every deep link through.
 */
export function parseSharePayload(url: string | null | undefined): SharedPayload | null {
  // Custom-scheme `<scheme>://share?…` only — http(s) URLs are ordinary web links, never a share delivery.
  if (!url || !/^(?!https?:)[a-z][a-z0-9.+-]*:\/\/share(\?|$)/i.test(url)) return null;
  const q = new URLSearchParams(url.split('?')[1] ?? '');
  const payload: SharedPayload = {};
  const text = q.get('text');
  if (text) payload.text = text;
  const title = q.get('title');
  if (title) payload.title = title;
  const files = q.getAll('file');
  if (files.length) payload.files = files;
  return Object.keys(payload).length ? payload : null;
}

/**
 * Inbound share-target (`shareTarget` module — opt-in): receive content shared TO the app from the
 * OS share sheet. Delivery rides the deep-link path — the shell synthesizes
 * `<urlScheme>://share?text=…&title=…&file=…` for both cold launches (handshake deep link) and warm
 * shares (deeplink.open) — so this module is a thin typed parser over `kit.lifecycle`.
 *
 * Capability (honest): Android + iOS `'native'` — Android via an ACTION_SEND intent-filter on the
 * main activity, iOS via a generated `AppwrapShare` share-extension target that forwards over the
 * app's `urlScheme` (config REQUIRED) with images crossing through the App Group container; web
 * `'none'` (no Web Share Target wiring).
 */
export class ShareTargetModule {
  private launchConsumed = false;

  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('shareTarget');
  }

  /**
   * Subscribe to inbound shares. Fires for warm shares immediately; the COLD-START share (the app was
   * launched by the share) is replayed once to the first subscriber after `kit.ready()` resolves —
   * subscribe early (right after boot) to catch it.
   */
  /**
   * Publish the app's SHARE CONTEXT — a small string KV the iOS share extension can read (App Group
   * `appwrap-share-context`) to complete a share directly against the app's backend (the config's
   * `shareTarget.directSync` lane resolves its `{key}` template placeholders from this KV). The
   * framework treats the KV as opaque — publish whatever your sync endpoint needs (e.g. `{ binId }`)
   * and re-publish whenever it changes. `null` clears it (direct sync falls back to the mailbox).
   * Rejects (`UNSUPPORTED`) on the web / on shells that predate the method — treat it as
   * fire-and-forget with a `.catch` (the mailbox path needs no context).
   */
  setContext(context: Record<string, string | number> | null): Promise<void> {
    return this.kit.invoke('shareTarget.setContext', { context });
  }

  onReceive(cb: (payload: SharedPayload) => void): Unsubscribe {
    let cancelled = false;
    void this.kit
      .ready()
      .then(() => {
        if (cancelled || this.launchConsumed) return;
        const payload = parseSharePayload(this.kit.handshakeInfo?.deepLink);
        if (payload) {
          this.launchConsumed = true; // read-once: a second subscriber shouldn't re-ingest it
          cb(payload);
        }
      })
      .catch(() => { /* web/no-shell: no handshake, nothing to replay */ });
    const un = this.kit.on('deeplink.open', (p) => {
      const payload = parseSharePayload((p as { url: string }).url);
      if (payload) cb(payload);
    });
    return () => {
      cancelled = true;
      un();
    };
  }
}
