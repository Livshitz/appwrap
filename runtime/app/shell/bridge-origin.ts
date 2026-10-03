import { SHELL_CONFIG } from './config';
import { effectiveServerUrl } from './server-url';

/**
 * Bridge origin gate. The shell's WebView can show ANY page (a link, a redirect, a page the app opens), and
 * every page in it can post to the `appwrap` channel — so without a gate a foreign page reads the app's
 * keychain (`storage.secure`), files, cookies, contacts… The APP's own origin keeps the full bridge:
 * the bundled `app://localhost`, the server loader's origin (incl. an allowlisted env override), and
 * `appBoundDomains`. Any other origin (or an unknown one) gets only FOREIGN_ALLOWED: UI feedback and
 * permission-prompted features that expose no stored app data.
 */
const FOREIGN_ALLOWED = [
  'app.handshake', 'app.environment', 'device.info', 'network.status',
  'haptics.', 'toast.', 'keyboard.', 'ui.', 'screen.', 'scanner.', 'push.', 'share.share',
];

/** `scheme://host[:port]` of a URL, lowercased, default ports dropped; '' if unparseable. */
export function originOf(url: string | null | undefined): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(String(url || ''));
  if (!m) return '';
  const scheme = m[1].toLowerCase();
  const host = (m[2].split('@').pop() || '').toLowerCase();
  const dflt = scheme === 'https' ? ':443' : scheme === 'http' ? ':80' : '';
  return `${scheme}://${dflt && host.endsWith(dflt) ? host.slice(0, -dflt.length) : host}`;
}

/** Is `origin` the app's own (full bridge)? Fail-closed: an empty/unknown origin is foreign. */
export function isTrustedOrigin(origin: string | null | undefined): boolean {
  const o = originOf(origin);
  if (!o) return false;
  if (o === 'app://localhost' || (SHELL_CONFIG.loader === 'file' && o === 'file://')) return true;
  if (SHELL_CONFIG.loader === 'server' && o === originOf(effectiveServerUrl())) return true;
  return (SHELL_CONFIG.appBoundDomains ?? []).some((h) => o === `https://${String(h).toLowerCase()}`);
}

/** May a page of `origin` call `method`? */
export function bridgeAllows(origin: string | null | undefined, method: string): boolean {
  return isTrustedOrigin(origin) || FOREIGN_ALLOWED.some((a) => (a.endsWith('.') ? method.startsWith(a) : method === a));
}
