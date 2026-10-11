import { ApplicationSettings } from '@nativescript/core';
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
  // Android serves the bundle from https://appwrap.local (custom-webview.android APP_ORIGIN, intercepted in-process).
  if (SHELL_CONFIG.loader !== 'server' && SHELL_CONFIG.loader !== 'file' && o === 'https://appwrap.local') return true;
  if (SHELL_CONFIG.loader === 'server' && o === originOf(effectiveServerUrl())) return true;
  return (SHELL_CONFIG.appBoundDomains ?? []).some((h) => o === `https://${String(h).toLowerCase()}`);
}

/**
 * Origin grants: the app (a trusted origin, via `bridge.grant`) lets ONE foreign origin call a few named methods — e.g.
 * a server the user paired may read the clipboard. Persisted; `methods: []` revokes. Never a wildcard.
 */
const GRANTS_KEY = 'appwrap.originGrants';
let grants: Record<string, string[]> | undefined;
const loadGrants = (): Record<string, string[]> => {
  if (!grants) { try { grants = JSON.parse(ApplicationSettings.getString(GRANTS_KEY, '{}')) || {}; } catch { grants = {}; } }
  return grants!;
};
export function originGrants(): Record<string, string[]> { return { ...loadGrants() }; }
export function grantOrigin(origin: string, methods: string[]): void {
  const o = originOf(origin);
  if (!o || !/^https?:\/\//.test(o)) throw Object.assign(new Error(`not a web origin: ${origin}`), { code: 'INVALID' });
  const g = loadGrants(), list = [...new Set((methods || []).map(String).filter((m) => m && !m.endsWith('.') && m !== '*' && !m.startsWith('bridge.')))];
  if (list.length) g[o] = list; else delete g[o];
  ApplicationSettings.setString(GRANTS_KEY, JSON.stringify(g));
}

/** May a page of `origin` call `method`? */
export function bridgeAllows(origin: string | null | undefined, method: string): boolean {
  return isTrustedOrigin(origin) || FOREIGN_ALLOWED.some((a) => (a.endsWith('.') ? method.startsWith(a) : method === a))
    || !!loadGrants()[originOf(origin)]?.includes(method);
}
