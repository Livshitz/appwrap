import { Utils } from '@nativescript/core';
import { mimeFor } from './mime';
import { requestPermissions, startActivityForResult } from './android-helpers';

/**
 * `<input type="file">` support for the Android WebView.
 *
 * WHY THIS FILE EXISTS: we replace NativeScript's WebChromeClient wholesale
 * (custom-webview.android.ts → setWebChromeClient), so the platform's own file-chooser
 * handling is gone with it. Without an `onShowFileChooser` override, tapping a file input
 * does NOTHING — no picker, no callback. (iOS needs none: WKWebView implements the picker itself.)
 *
 * THE ONE INVARIANT: `filePathCallback.onReceiveValue` MUST be invoked EXACTLY ONCE on every
 * path — success, cancel, back, no-activity, thrown exception. Chromium keeps the input in a
 * "chooser open" state until the callback fires, so a missed call wedges that input PERMANENTLY
 * for the rest of the page's life (a second tap silently does nothing). Hence the `settled`
 * latch + the catch-all reject path below; never add an early `return` that skips `deliver`.
 *
 * STATE: everything is per-invocation closure state over the callback/params ARGUMENTS. The
 * WebChromeClient Java proxy is shared across every webview (NS caches the class — see the
 * header comment in custom-webview.android.ts), so holding per-request state on the client or
 * in a module-level slot would cross-wire concurrent requests and separate webviews. Don't.
 */
export function showFileChooser(
  filePathCallback: android.webkit.ValueCallback<androidNative.Array<android.net.Uri>>,
  params: android.webkit.WebChromeClient.FileChooserParams
): boolean {
  let settled = false;
  const deliver = (uris: androidNative.Array<android.net.Uri> | null): void => {
    if (settled) return;
    settled = true;
    Utils.dispatchToMainThread(() => {
      try {
        filePathCallback.onReceiveValue(uris);
      } catch (e) {
        console.warn('[appwrap] file-chooser callback failed: ' + e);
      }
    });
  };

  try {
    pick(params).then(deliver, (e) => {
      console.warn('[appwrap] file-chooser failed: ' + e);
      deliver(null); // cancel semantics — the input stays usable
    });
  } catch (e) {
    console.warn('[appwrap] file-chooser threw: ' + e);
    deliver(null);
  }
  return true; // we own the request (returning false = "no chooser", input goes inert)
}

/** accept="" tokens → intent MIME types. `.png` style extensions map through the shared MIME table. */
function acceptMimes(params: any): string[] {
  const raw: string[] = Array.from(params?.getAcceptTypes?.() ?? []).map(String);
  const out = new Set<string>();
  for (const t of raw) {
    const token = t.trim();
    if (!token) continue; // the platform pads getAcceptTypes() with empty strings for accept=""
    if (token.startsWith('.')) out.add(mimeFor(token.slice(1).toLowerCase()));
    else if (token.includes('/')) out.add(token);
  }
  // application/octet-stream is mimeFor's fallback for an unknown extension — it matches nothing
  // in the picker, so an unresolvable accept must widen to "any file", not narrow to nothing.
  if (out.has('application/octet-stream')) return [];
  return Array.from(out);
}

async function pick(params: any): Promise<androidNative.Array<android.net.Uri> | null> {
  const mimes = acceptMimes(params);
  const FCP = android.webkit.WebChromeClient.FileChooserParams;
  const multiple = params?.getMode?.() === FCP.MODE_OPEN_MULTIPLE;

  if (params?.isCaptureEnabled?.()) {
    const captured = await capture(mimes);
    // Fall through to the normal picker ONLY when the capture path is UNAVAILABLE (no capture
    // app, CAMERA denied): `capture` is a HINT in the HTML spec, not a hard requirement.
    // A settled capture ends the request — including a CANCEL (`uris: null`), which must return
    // the user to the page, not ambush them with a second picker they never asked for.
    if (captured.settled) return captured.uris;
  }

  const I = android.content.Intent;
  const intent = new I(I.ACTION_GET_CONTENT);
  intent.addCategory(I.CATEGORY_OPENABLE);
  intent.setType(mimes.length === 1 ? mimes[0] : '*/*');
  if (mimes.length > 1) {
    const arr = (Array as any).create(java.lang.String, mimes.length);
    mimes.forEach((m, i) => (arr[i] = new java.lang.String(m)));
    intent.putExtra(I.EXTRA_MIME_TYPES, arr);
  }
  if (multiple) intent.putExtra(I.EXTRA_ALLOW_MULTIPLE, true);

  const { resultCode, intent: data } = await startActivityForResult(intent);
  if (resultCode !== android.app.Activity.RESULT_OK || !data) return null;
  return toUriArray(collect(data));
}

/** Multi-select arrives as ClipData; single select as the intent's data Uri. */
function collect(data: android.content.Intent): android.net.Uri[] {
  const uris: android.net.Uri[] = [];
  const clip = data.getClipData?.();
  if (clip) {
    for (let i = 0; i < clip.getItemCount(); i++) {
      const u = clip.getItemAt(i).getUri();
      if (u) uris.push(u);
    }
  }
  const single = data.getData?.();
  if (!uris.length && single) uris.push(single);
  return uris;
}

function toUriArray(uris: android.net.Uri[]): androidNative.Array<android.net.Uri> | null {
  if (!uris.length) return null;
  const arr = (Array as any).create(android.net.Uri, uris.length);
  uris.forEach((u, i) => (arr[i] = u));
  return arr;
}

/**
 * capture="" path: MediaStore capture intents. Image capture writes to a FileProvider-backed
 * cache file (EXTRA_OUTPUT) so the web layer gets a FULL-SIZE file rather than the ~100px
 * thumbnail the extras-only path returns.
 *
 * `settled:false` means the capture path is UNAVAILABLE (no capture activity / CAMERA denied) —
 * the ONLY case the caller may fall back to the normal picker. `settled:true` owns the request:
 * `uris` carries the capture, or is null when the user CANCELLED (back out of the camera). The
 * two were once both a bare null, which turned one cancel into a second, unrequested picker.
 */
type CaptureResult =
  | { settled: true; uris: androidNative.Array<android.net.Uri> | null }
  | { settled: false };

async function capture(mimes: string[]): Promise<CaptureResult> {
  const kind = mimes[0]?.split('/')[0] ?? 'image';
  const MS = android.provider.MediaStore;
  const ctx = Utils.android.getApplicationContext();
  const I = android.content.Intent;

  const action = kind === 'video' ? MS.ACTION_VIDEO_CAPTURE
    : kind === 'audio' ? MS.Audio.Media.RECORD_SOUND_ACTION
      : MS.ACTION_IMAGE_CAPTURE;
  const intent = new I(action);
  if (!intent.resolveActivity(ctx.getPackageManager())) return { settled: false };

  // CAMERA is only REQUIRED when the app DECLARES it: Android denies a capture intent to an app
  // that declares the permission without holding it, but asks nothing of an app that doesn't
  // declare it at all. Requesting an undeclared permission returns denied forever → a dead
  // capture path in apps that never opted into the camera module.
  if (action !== MS.Audio.Media.RECORD_SOUND_ACTION && declares('android.permission.CAMERA')) {
    if (!(await requestPermissions(['android.permission.CAMERA']))) return { settled: false };
  }

  let output: android.net.Uri | null = null;
  if (action === MS.ACTION_IMAGE_CAPTURE) {
    const dir = new java.io.File(ctx.getCacheDir(), 'shared'); // already exposed by file_paths.xml
    dir.mkdirs();
    const file = new java.io.File(dir, 'capture-' + java.lang.System.currentTimeMillis() + '.jpg');
    output = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.getPackageName() + '.fileprovider', file);
    intent.putExtra(MS.EXTRA_OUTPUT, output);
    intent.addFlags(I.FLAG_GRANT_WRITE_URI_PERMISSION | I.FLAG_GRANT_READ_URI_PERMISSION);
  }

  const { resultCode, intent: data } = await startActivityForResult(intent);
  // Cancelled (BACK out of the camera) — settled, with nothing: the caller delivers null.
  if (resultCode !== android.app.Activity.RESULT_OK) return { settled: true, uris: null };
  // EXTRA_OUTPUT captures return no data Uri — the bytes landed in `output`.
  const uris = data ? collect(data) : [];
  if (!uris.length && output) uris.push(output);
  return { settled: true, uris: toUriArray(uris) };
}

function declares(permission: string): boolean {
  try {
    const ctx = Utils.android.getApplicationContext();
    const info = ctx.getPackageManager().getPackageInfo(
      ctx.getPackageName(),
      android.content.pm.PackageManager.GET_PERMISSIONS
    );
    return Array.from(info.requestedPermissions ?? []).map(String).includes(permission);
  } catch (e) {
    return false;
  }
}

declare const androidx: any; // androidx.core.content.FileProvider — not in the android-32 platform typings
