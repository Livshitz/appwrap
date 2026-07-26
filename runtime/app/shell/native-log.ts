import { knownFolders, path as nsPath } from '@nativescript/core';

/**
 * Single debug log sink → Documents/appwrap-web.log. Both the forwarded WebView console
 * (custom-webview) and native shell diagnostics (handlers) write here, because NativeScript's
 * native `console.log`/`NSLog` do NOT surface to `devicectl --console`/`idevicesyslog` on a device
 * build. Pull it with `appwrap logs ios`. Native lines are tagged `[native:*]`. Capped per session.
 */
let _log = '';

export function appwrapNativeLog(line: string): void {
  try {
    _log += line + '\n';
    if (_log.length > 160000) _log = _log.slice(-120000);
    const p = nsPath.join(knownFolders.documents().path, 'appwrap-web.log');
    NSString.stringWithString(_log).writeToFileAtomicallyEncodingError(p, true, 4 /*NSUTF8*/);
  } catch {
    /* best-effort */
  }
}
