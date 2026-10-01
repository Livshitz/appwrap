import { ApplicationSettings, Dialogs, Http } from '@nativescript/core';
import { SHELL_CONFIG } from './config';
import { URL_PARAMS_KEY, effectiveBaseUrl, storedUrlParams } from './server-url';

/**
 * Config-driven URL-param menu for the env-switcher (`envSwitcher.params`). Each declared param adds a
 * "<Label>: <current>" entry to the Switch Environment sheet; picking a value persists it (`kit:urlParams`)
 * and reloads the WebView with `?<key>=<value>` appended (see `withUrlParams` in server-url.ts). The first
 * option, "default", means "no param". Same gate as the env-switcher itself — no separate trust surface.
 *
 * Options come from a static `options` list and/or `optionsUrl` — a JSON GET resolved against the ACTIVE
 * env's base URL (so a relative path follows an env switch). `optionsPath` (dot path) selects the value
 * inside the response; an array yields its string items, an object yields its keys.
 */

export type UrlParamDef = (typeof SHELL_CONFIG.envSwitcher.params)[number];

export const DEFAULT_OPTION = 'default';

export function urlParamDefs(): UrlParamDef[] {
  return SHELL_CONFIG.envSwitcher?.params ?? [];
}

/** Menu entry label for a param, e.g. "Segment: senior". */
export function paramMenuLabel(p: UrlParamDef): string {
  return `${p.label || p.key}: ${storedUrlParams()[p.key] || DEFAULT_OPTION}`;
}

/** Extract string options from a JSON response: walk `path`, then array → strings, object → keys. */
export function extractOptions(json: unknown, path = ''): string[] {
  let v: any = json;
  for (const k of path.split('.').filter(Boolean)) v = v?.[k];
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v) : [];
  return list.filter((s): s is string => typeof s === 'string' && !!s);
}

/** Resolve the param's options: "default" + static options + fetched options (deduped). A failed fetch
 * is logged and falls back to the static list — the menu still opens. */
export async function loadParamOptions(p: UrlParamDef): Promise<string[]> {
  const opts = [...(p.options ?? [])];
  if (p.optionsUrl) {
    const url = new URL(p.optionsUrl, effectiveBaseUrl()).toString();
    try {
      const res = await Http.request({ url, method: 'GET', timeout: 8000 });
      if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
      opts.push(...extractOptions(res.content?.toJSON(), p.optionsPath));
    } catch (e: any) {
      console.warn(`AppWrap: url-param "${p.key}" options fetch failed (${url}): ${e?.message ?? e}`);
    }
  }
  return [...new Set([DEFAULT_OPTION, ...opts])];
}

/** Persist one param value ('' / "default" clears it). */
export function setUrlParam(key: string, value: string): void {
  const next = { ...storedUrlParams() };
  if (!value || value === DEFAULT_OPTION) delete next[key];
  else next[key] = value;
  ApplicationSettings.setString(URL_PARAMS_KEY, JSON.stringify(next));
}

/** Action sheet for one param; on a changed pick, persist + `reload()`. */
export async function showParamPicker(p: UrlParamDef, reload: () => void): Promise<void> {
  const current = storedUrlParams()[p.key] || DEFAULT_OPTION;
  const options = await loadParamOptions(p);
  const choice = await Dialogs.action({
    title: p.label || p.key,
    message: `Current: ${current}`,
    cancelButtonText: 'Cancel',
    actions: options.map((o) => (o === current ? `${o} ✓` : o)),
  });
  if (!choice || choice === 'Cancel') return;
  const value = choice.replace(/ ✓$/, '');
  if (value === current) return;
  setUrlParam(p.key, value);
  reload();
}
