import { ApplicationSettings } from '@nativescript/core';
import { SHELL_CONFIG } from './config';

/**
 * Persisted serverUrl override for `loader:'server'` shells.
 *
 * A web debug tool (e.g. an in-app env switcher) can point the WebView at a different origin at
 * runtime. `window.location` only lasts the session — on a cold start the shell reloads its
 * build-time `serverUrl`, and web `localStorage` is partitioned per-origin so it can't carry the
 * choice across the switch. The fix lives in the shell: persist the chosen URL in native storage
 * (survives restarts + origin changes) and read it HERE at every boot/reload site.
 *
 * The web writes it through the existing `kit.storage` seam — `kit.storage.set('serverUrlOverride',
 * url)` — which stores `JSON.stringify(url)` under the namespaced key `kit:serverUrlOverride`
 * (ApplicationSettings → NSUserDefaults / SharedPreferences). Clearing it (`kit.storage.remove`)
 * reverts to the build-time `serverUrl` on the next load.
 *
 * SECURITY: honored ONLY when the env-switcher is configured + enabled (`SHELL_CONFIG.envSwitcher.enabled`
 * — the config block is present and not `enabled:false`). An app that doesn't declare `envSwitcher`, or a
 * prod fork that sets `enabled:false`, ignores the key entirely, so a compromised page can't persistently
 * redirect the shell. The switcher's own gate (menu + allowPattern + confirm) governs what can be written;
 * this is the read side. Runs in ALL build types when enabled — distinct from the debug-only cert trust.
 */
export const OVERRIDE_KEY = 'kit:serverUrlOverride';

/**
 * Full-string allowlist test for a candidate "Other"/override URL. DEFAULT-DENY: an empty or throwing
 * `allowPattern` rejects everything. Enforces a FULL-STRING match (guards a non-anchored pattern that
 * would otherwise match a substring). Bounded input length guards against pathological backtracking on a
 * hostile pattern. Lives here (not env-switcher.ts) so the boot loader can reuse it without an import
 * cycle — env-switcher.ts imports it back for the "Other" prompt.
 */
export function isUrlAllowed(url: string): boolean {
  const pattern = SHELL_CONFIG.envSwitcher?.allowPattern;
  if (!pattern) return false; // default-deny: no allowlist configured
  if (!/^https?:\/\//i.test(url) || url.length > 2048) return false;
  try {
    const re = new RegExp(pattern);
    const m = url.match(re);
    return !!m && m[0] === url; // full-string match, regardless of author anchoring
  } catch {
    return false; // throwing pattern → default-deny
  }
}

/** Is a stored/entered override URL trustworthy? A declared preset is implicitly allowed; otherwise it
 * must match `allowPattern`. Used by BOTH the boot loader (re-validate the persisted override) and the
 * switcher, so a compromised page that writes an arbitrary `serverUrlOverride` directly through the
 * `kit.storage` bridge seam can't redirect the shell — the write is ignored at boot unless allowlisted. */
export function isOverrideAllowed(url: string): boolean {
  const presets = SHELL_CONFIG.envSwitcher?.envs ?? [];
  if (presets.some((e) => e.url === url)) return true; // presets are implicitly trusted
  return isUrlAllowed(url);
}

/** The URL a server-loader shell should load at boot/reload: a valid, ALLOWLISTED persisted override when
 * the env-switcher is enabled, else the build-time `SHELL_CONFIG.serverUrl`. Re-validates the stored
 * override against the same allowlist the switcher uses — the native menu isn't the only writer of the
 * key (any page JS can write it via `kit.storage.set`), so the read side must not trust it blindly. */
export function effectiveServerUrl(): string {
  if (SHELL_CONFIG.loader !== 'server') return SHELL_CONFIG.serverUrl;
  if (SHELL_CONFIG.envSwitcher?.enabled) {
    try {
      const raw = ApplicationSettings.getString(OVERRIDE_KEY, '');
      if (raw) {
        const url = JSON.parse(raw);
        if (typeof url === 'string' && /^https?:\/\//i.test(url) && isOverrideAllowed(url)) return url;
      }
    } catch {
      /* malformed override — fall back to the build-time serverUrl */
    }
  }
  return SHELL_CONFIG.serverUrl;
}
