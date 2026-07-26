import { Application, Utils, isAndroid, isIOS } from '@nativescript/core';
import type { AndroidActivityNewIntentEventData } from '@nativescript/core';
import { SHELL_CONFIG } from './config';
import { bridge } from './bridge';
import { onDeepLink, setDeepLinkTransformer } from './events';
import { MAILBOX_KEY, drainShareMailbox, type ShareMailboxStore } from './share-mailbox';

/** App Group UserDefaults key holding the app-published SHARE CONTEXT (JSON string KV). Written by
 * `shareTarget.setContext`, read by the AppwrapShare extension to resolve direct-sync `{key}`
 * template placeholders. Must match ShareViewController.swift. */
const CONTEXT_KEY = 'appwrap-share-context';

/**
 * shareTarget (INBOUND share sheet) — Android. The SEND(_MULTIPLE) intent-filters live on the
 * LIGHTWEIGHT `cc.appwrap.share.AppwrapShareActivity` (module Kotlin source, translucent — the iOS
 * drawer's parity): it direct-syncs when configured, and on any failure launches the app with the
 * `<urlScheme>://share?…` deep link below (a VIEW intent → the normal deep-link path). The SEND
 * handler here remains for builds whose manifest still carries the filters on the main activity
 * (pre-parity installs): it reads the intent (cold launch + warm onNewIntent) and re-delivers
 * through the EXISTING deep-link path as a synthetic URL — inheriting the proven cold-start
 * buffering (handshake `deepLink`) and warm `deeplink.open` event with no new bridge surface.
 *
 * URL contract (parsed by kit.shareTarget, also directly consumable via kit.lifecycle.onDeepLink):
 *   <urlScheme>://share?text=<enc>&title=<enc>&file=<enc>&file=<enc>…
 *  - `text`  — EXTRA_TEXT (shared text / URL), when present.
 *  - `title` — EXTRA_SUBJECT, when present.
 *  - `file`  — repeated; each is a path RELATIVE TO THE APP CACHE DIR (`appwrap-share/…`) where the
 *    shared stream (image) was copied — read it via `kit.fs.read(p, { dir: 'cache', encoding: 'base64' })`.
 *
 * iOS: the generated `AppwrapShare` extension (this module's nativeSrc) PERSISTS the payload as the
 * SAME URL into an App-Group "mailbox" (UserDefaults key `appwrap-share-mailbox`, a string array) —
 * modern iOS silently blocks a share extension from launching its host via `openURL:`, so there is
 * no live hand-off; the host drains the mailbox on cold launch and on every foreground/resume
 * (read-once) and feeds each URL through the normal deep-link path (cold: buffered into the
 * handshake `deepLink`; warm: `deeplink.open` event). Text rides in the URL directly; images land in
 * the App Group container as `gfile=<name>` params, which the transformer below relocates into the
 * app cache and rewrites to `file=` (cache-relative) so the contract the web app sees is
 * platform-identical.
 */
export function registerShareTargetHandlers(): void {
  // Share-context KV (kit.shareTarget.setContext) — generic, app-opaque. iOS persists it in the App
  // Group (read by the AppwrapShare extension); Android persists it in SharedPreferences
  // `appwrap-share`/`context` (read by cc.appwrap.share.AppwrapShareActivity's direct sync).
  bridge.register('shareTarget.setContext', ({ context }: { context?: Record<string, string | number> | null }) => {
    const json = context && typeof context === 'object' ? JSON.stringify(context) : null;
    if (isIOS) {
      const d = NSUserDefaults.alloc().initWithSuiteName(`group.${SHELL_CONFIG.appId}`);
      if (!d) return;
      if (json) d.setObjectForKey(json, CONTEXT_KEY);
      else d.removeObjectForKey(CONTEXT_KEY);
      return;
    }
    if (!isAndroid) return;
    const prefs = (Utils.android.getApplicationContext() as android.content.Context)
      .getSharedPreferences('appwrap-share', 0 /* MODE_PRIVATE */);
    const ed = prefs.edit();
    if (json) ed.putString('context', json);
    else ed.remove('context');
    ed.apply();
  });
  if (isIOS) {
    // Rewrite share links carrying App-Group files (gfile=) → cache files (file=). Text-only share
    // links (no gfile) pass through untouched.
    setDeepLinkTransformer((url) => (url.includes('://share?') && url.includes('gfile=') ? iosRelocateGroupFiles(url) : url));
    const drain = () => {
      try { drainShareMailbox(iosMailboxStore(), onDeepLink); }
      catch (e) { console.warn('AppWrap: share mailbox drain failed', e); }
    };
    drain(); // cold launch — a share made while the app was killed is waiting in the mailbox
    Application.on(Application.resumeEvent, drain); // warm — user shared, then switched back to the app
    return;
  }
  if (!isAndroid) return;
  Application.android.on(Application.android.activityNewIntentEvent, (args: AndroidActivityNewIntentEventData) =>
    deliverShareIntent(args.intent)
  );
  // Cold start: the SEND intent IS the launch intent (events.ts only reads getData(), null for SEND).
  deliverShareIntent(Application.android.startActivity?.getIntent?.());
}

// ── iOS App-Group mailbox (written by the AppwrapShare extension, drained by the host) ──
// Drain semantics (read-once, crash-safe) are PURE and live in share-mailbox.ts (bun-tested).

/** The real iOS store: `group.<appId>` suite UserDefaults, string-array under MAILBOX_KEY. */
function iosMailboxStore(): ShareMailboxStore {
  const defaults = NSUserDefaults.alloc().initWithSuiteName(`group.${SHELL_CONFIG.appId}`);
  return {
    read: () => {
      const arr = defaults?.arrayForKey(MAILBOX_KEY);
      const out: string[] = [];
      for (let i = 0; arr && i < arr.count; i++) out.push(String(arr.objectAtIndex(i)));
      return out;
    },
    clear: () => { defaults?.removeObjectForKey(MAILBOX_KEY); },
  };
}

/** iOS: move each `gfile=<name>` from `<AppGroup>/appwrap-share/` into `<Caches>/appwrap-share/` and
 * rewrite the param to `file=appwrap-share/<name>` (the fs `cache` root), matching Android's shape.
 * Any file that can't be moved (missing group container, purged file) is dropped from the link;
 * text/title params always survive. */
function iosRelocateGroupFiles(url: string): string {
  try {
    const [head, query = ''] = url.split('?');
    const fm = NSFileManager.defaultManager;
    const groupRoot = fm.containerURLForSecurityApplicationGroupIdentifier(`group.${SHELL_CONFIG.appId}`);
    const cacheBase = NSSearchPathForDirectoriesInDomains(13 /* Caches */, 1, true).objectAtIndex(0) as string;
    const destDir = `${cacheBase}/appwrap-share`;
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(destDir, true, null, null);
    const params: string[] = [];
    for (const pair of query.split('&')) {
      if (!pair.startsWith('gfile=')) { if (pair) params.push(pair); continue; }
      if (!groupRoot) continue; // no group entitlement in this build — drop the file, keep the text
      const name = decodeURIComponent(pair.slice('gfile='.length));
      if (!name || name.includes('/') || name.includes('..')) continue; // extension controls names — don't let one escape the dir
      const src = `${String(groupRoot.path)}/appwrap-share/${name}`;
      const dest = `${destDir}/${name}`;
      fm.removeItemAtPathError(dest, null); // overwrite-safe (moveItem fails on an existing dest)
      if (fm.moveItemAtPathToPathError(src, dest, null)) params.push(`file=${encodeURIComponent(`appwrap-share/${name}`)}`);
    }
    return `${head}?${params.join('&')}`;
  } catch (e) {
    console.warn('AppWrap: share group-file relocation failed', e);
    return url;
  }
}

const CONSUMED = 'appwrap_share_consumed';

function deliverShareIntent(intent: android.content.Intent | null | undefined): void {
  try {
    const action = intent?.getAction?.();
    if (action !== 'android.intent.action.SEND' && action !== 'android.intent.action.SEND_MULTIPLE') return;
    if (intent!.getBooleanExtra?.(CONSUMED, false)) return; // relayout re-read of the same launch intent
    intent!.putExtra?.(CONSUMED, true);

    const params: string[] = [];
    const text = intent!.getStringExtra?.(android.content.Intent.EXTRA_TEXT);
    if (text) params.push(`text=${encodeURIComponent(String(text))}`);
    const subject = intent!.getStringExtra?.(android.content.Intent.EXTRA_SUBJECT);
    if (subject) params.push(`title=${encodeURIComponent(String(subject))}`);
    for (const rel of copySharedStreams(intent!, action)) params.push(`file=${encodeURIComponent(rel)}`);
    if (!params.length) return;

    // Scheme is cosmetic here — the URL goes straight into onDeepLink, never through the OS.
    const scheme = SHELL_CONFIG.urlScheme || 'app';
    onDeepLink(`${scheme}://share?${params.join('&')}`);
  } catch (e) {
    console.warn('AppWrap: share intent read failed', e);
  }
}

/** Copy each EXTRA_STREAM content:// URI into `<cacheDir>/appwrap-share/`; return cache-relative paths. */
function copySharedStreams(intent: android.content.Intent, action: string): string[] {
  const uris: android.net.Uri[] = [];
  try {
    if (action === 'android.intent.action.SEND_MULTIPLE') {
      const list = intent.getParcelableArrayListExtra?.(android.content.Intent.EXTRA_STREAM);
      for (let i = 0; list && i < list.size(); i++) uris.push(list.get(i) as android.net.Uri);
    } else {
      const one = intent.getParcelableExtra?.(android.content.Intent.EXTRA_STREAM) as android.net.Uri | null;
      if (one) uris.push(one);
    }
  } catch (e) {
    console.warn('AppWrap: share stream extras read failed', e);
  }

  const out: string[] = [];
  if (!uris.length) return out;
  const ctx = Utils.android.getApplicationContext() as android.content.Context;
  const dir = new java.io.File(ctx.getCacheDir(), 'appwrap-share');
  dir.mkdirs();
  const resolver = ctx.getContentResolver();
  uris.forEach((uri, i) => {
    try {
      const name = fileNameFor(resolver, uri, i);
      const dest = new java.io.File(dir, name);
      const input = resolver.openInputStream(uri);
      if (!input) return;
      const output = new java.io.FileOutputStream(dest);
      const buf = Array.create('byte', 64 * 1024);
      let n: number;
      while ((n = input.read(buf)) > 0) output.write(buf, 0, n);
      output.close();
      input.close();
      out.push(`appwrap-share/${name}`);
    } catch (e) {
      console.warn('AppWrap: shared stream copy failed', e);
    }
  });
  return out;
}

/** A safe, unique-enough filename: display name when the provider offers one, else mime-derived. */
function fileNameFor(resolver: android.content.ContentResolver, uri: android.net.Uri, i: number): string {
  let name = '';
  try {
    const c = resolver.query(uri, null, null, null, null);
    if (c) {
      const idx = c.getColumnIndex('_display_name');
      if (idx >= 0 && c.moveToFirst()) name = String(c.getString(idx) ?? '');
      c.close();
    }
  } catch { /* fall through to mime-derived name */ }
  if (!name) {
    const mime = String(resolver.getType(uri) ?? '');
    const ext = mime.startsWith('image/') ? mime.slice(6).replace(/[^a-z0-9]/gi, '') || 'img' : 'bin';
    name = `shared-${i}.${ext}`;
  }
  // Sanitize (providers control display names) + prefix a timestamp so repeated shares don't collide.
  return `${Date.now()}-${i}-${name.replace(/[^\w.-]/g, '_')}`;
}
