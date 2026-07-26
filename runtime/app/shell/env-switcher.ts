import { ApplicationSettings, Dialogs, Utils, isAndroid, isIOS } from '@nativescript/core';
import type { EventData, LoadEventData } from '@nativescript/core';
import { SHELL_CONFIG } from './config';
import { OVERRIDE_KEY, effectiveServerUrl, isUrlAllowed } from './server-url';
import { bridge } from './bridge';
import { refreshEnvBanner } from './env-banner';
import { refreshEnvKeepAwake } from './env-keepawake';

/**
 * Runtime env-switcher — re-point a `loader:'server'` shell between declared environments (prod / lab /
 * a preview URL) at runtime, surviving a cold start, with NO separate native build. First-party capability
 * (not a plugin), opt-in via `SHELL_CONFIG.envSwitcher`. Inert unless the config block is present AND
 * `enabled` (a prod fork can set `enabled:false` to hard-disable).
 *
 * SECURITY MODEL (distinct from the debug-only dev-server cert trust): this runs in ALL build types when
 * configured. The gate is a REGEX ALLOWLIST + a CONFIRM prompt, not build-type. Declared presets (`envs`)
 * are always trusted; a free-form "Other" URL must match `allowPattern` (anchored, full-string, compiled
 * with try/catch — a throwing/absent pattern is treated as DEFAULT-DENY: "Other" disabled). The chosen URL
 * is persisted through the same native-storage seam the boot loader reads (`kit:serverUrlOverride`).
 */

export function isEnvSwitcherEnabled(): boolean {
  return SHELL_CONFIG.loader === 'server' && !!SHELL_CONFIG.envSwitcher?.enabled;
}

/** Host[:port] of a URL — scheme/path/query/fragment/userinfo stripped. '' if unparseable. */
export function hostOf(url: string): string {
  const afterScheme = String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = afterScheme.split(/[/?#]/)[0];
  return (authority.split('@').pop() || authority).toLowerCase();
}

/** The currently persisted override URL, or '' when none / malformed / feature disabled. */
export function currentOverride(): string {
  if (!isEnvSwitcherEnabled()) return '';
  try {
    const raw = ApplicationSettings.getString(OVERRIDE_KEY, '');
    if (!raw) return '';
    const url = JSON.parse(raw);
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

/**
 * True when a persisted override is active AND resolves to a host that DIFFERS from the build-time default
 * (`SHELL_CONFIG.serverUrl`). This — not raw `currentOverride()` — is the "you are NOT on the default env"
 * signal the banner keys off: an override whose host equals the build default is not an off-default state
 * (e.g. selecting the preset that equals the build default). Host-normalized via `hostOf` (host[:port],
 * lowercased) — note `hostOf` KEEPS the port (unlike the dev-cert match, which strips it), so two envs that
 * differ only by port compare as distinct; both sides use the same `hostOf`, so the equality test is sound.
 */
export function isNonDefaultOverride(): boolean {
  const override = currentOverride();
  if (!override) return false;
  return hostOf(override) !== hostOf(SHELL_CONFIG.serverUrl);
}

/** Label for the active env: a matching preset's label, else 'Custom' when an override is set, else ''. */
export function activeEnvLabel(): string {
  const override = currentOverride();
  if (!override) return '';
  const preset = (SHELL_CONFIG.envSwitcher?.envs ?? []).find((e) => e.url === override);
  return preset ? preset.label : 'Custom';
}

/** Persist an override (same encoding as `kit.storage.set` — JSON.stringify under the namespaced key). */
function writeOverride(url: string): void {
  ApplicationSettings.setString(OVERRIDE_KEY, JSON.stringify(url));
}

function clearOverride(): void {
  ApplicationSettings.remove(OVERRIDE_KEY);
}

/**
 * The switch is PERSISTED but the visible page did NOT change — the exact gap the confirm prompt's "The
 * app will reload" leaves the user staring at. Silence here reads as "the switch didn't work" (it did:
 * the override is already written, so a cold start WILL land on it), which is the actionable half and the
 * half that was missing. Name the host and the reason so an unreachable target (dev server down, DNS,
 * TLS/ATS refusal) is distinguishable from a broken switcher.
 */
function notifyNotReloaded(url: string, reason: string): void {
  console.warn(`AppWrap: env switch persisted but the in-session reload did not happen (${hostOf(url)}): ${reason}`);
  void Dialogs.alert({
    title: 'Still on the old environment',
    message: `Couldn't load ${hostOf(url)}.\n${reason}\n\nThe environment change IS saved — relaunch the app to use it.`,
    okButtonText: 'OK',
  });
}

/** Load the current effective server URL into the live WebView (immediate switch — no wait for a cold
 * start; the persisted override also makes it stick across relaunch via the boot loader).
 *
 * NEVER fail silently: both the no-WebView path and a FAILED load report through `notifyNotReloaded`.
 * The failure seam is NativeScript's own `loadFinished` event, whose `error` arg both platforms already
 * populate for a main-frame failure (iOS: WKNavigationDelegate didFail[Provisional]Navigation — a refused
 * connection is PROVISIONAL, which is exactly the case that bit; Android: WebViewClient.onReceivedError,
 * re-wired to NS in custom-webview.android.ts because our client replaces NS's). Reusing it keeps ONE
 * cross-platform seam — do NOT install a second WKNavigationDelegate here: custom-webview.ios.ts already
 * owns one (DevCertNavDelegate) and a competing delegate would silently unhook its cert trust.
 *
 * The handler is ONE-SHOT and armed immediately before the load, so it observes this switch's outcome and
 * cannot leak or mis-attribute a later navigation's error to the switch.
 */
function reloadToEffective(): void {
  const url = effectiveServerUrl();
  const wv = bridge.getWebView();
  if (!wv) {
    notifyNotReloaded(url, 'The app view is not available.');
    return;
  }
  // `on` resolves to Observable's generic overload here (CustomWebView widens the WebView-specific one),
  // so take EventData and narrow — `loadFinished` always carries LoadEventData.
  const onLoadFinished = (args: EventData) => {
    wv.off('loadFinished', onLoadFinished);
    const error = (args as LoadEventData).error;
    if (error) notifyNotReloaded(url, String(error));
  };
  wv.on('loadFinished', onLoadFinished);
  Utils.dispatchToMainThread(() => {
    if (isIOS && wv.ios) {
      (wv.ios as WKWebView).loadRequest(NSURLRequest.requestWithURL(NSURL.URLWithString(url)));
    } else if (isAndroid && wv.android) {
      wv.android.clearCache(true);
      wv.src = url;
    }
  });
}

/** Apply a switch after user confirmation: persist (or clear) then reload to the new effective URL. */
async function applySwitch(url: string | null, label: string): Promise<void> {
  const ok = await Dialogs.confirm({
    title: 'Switch environment',
    message: url ? `Load ${label}?\n${hostOf(url)}\n\nThe app will reload.` : 'Reset to the default environment?\nThe app will reload.',
    okButtonText: url ? 'Switch' : 'Reset',
    cancelButtonText: 'Cancel',
  });
  if (!ok) return;
  // Switching to a URL whose host equals the build-time default is really a RESET: persisting it would be
  // redundant state (the boot loader falls back to SHELL_CONFIG.serverUrl anyway) and would leave a
  // relaunch-visible key. Clear instead, so both the banner gate and a cold start land on "default".
  if (url && hostOf(url) !== hostOf(SHELL_CONFIG.serverUrl)) writeOverride(url);
  else clearOverride();
  reloadToEffective();
  refreshEnvBanner(); // in-session: reflect the new env (switch) or hide (reset) — not just on relaunch
  refreshEnvKeepAwake(); // same signal as the banner: awake off-default, normal on a reset — never disagree
}

let menuOpen = false;

/**
 * Show the "Switch Environment" action sheet: pick a declared preset, enter a free-form "Other" URL
 * (validated against `allowPattern`, default-deny), or reset to the build default. Every switch goes
 * through a confirm prompt. No-op when the feature is disabled.
 */
export async function showEnvSwitcher(): Promise<void> {
  if (!isEnvSwitcherEnabled() || menuOpen) return;
  menuOpen = true;
  try {
    const envs = SHELL_CONFIG.envSwitcher?.envs ?? [];
    const active = currentOverride();
    const allowOther = !!SHELL_CONFIG.envSwitcher?.allowPattern;
    const actions = envs.map((e) => (e.url === active ? `${e.label} ✓` : e.label));
    if (allowOther) actions.push('Other…');
    actions.push('Reset to default');

    const choice = await Dialogs.action({
      title: 'Switch Environment',
      message: active ? `Current: ${activeEnvLabel()} (${hostOf(active)})` : 'Current: default',
      cancelButtonText: 'Cancel',
      actions,
    });
    if (!choice || choice === 'Cancel') return;

    if (choice === 'Reset to default') return void (await applySwitch(null, 'default'));
    if (choice === 'Other…') return void (await promptOther());

    const label = choice.replace(/ ✓$/, '');
    const env = envs.find((e) => e.label === label);
    if (env) await applySwitch(env.url, env.label);
  } finally {
    menuOpen = false;
  }
}

// ── Deep-link entry (`<scheme>://env?to=<name>` | `?url=<encoded-url>`) ────────────────────────────
// A shared link can auto-open the app on a given env. Two additive forms: `?to=<name>` switches to a
// CONFIGURED preset by label (TRUSTED — bypasses the allowlist, like the manual switcher's presets);
// `?url=<encoded>` is a free-form target still gated by `isUrlAllowed` (anchored allowPattern, default-
// deny). Both go through a confirm prompt and apply via the EXACT SAME `applySwitch` path as a manual
// switch. events.ts owns the WebView-ready timing (warm: now; cold launch: buffered, replayed after
// the PWA handshake).

export type EnvDeepLinkDecision =
  | { action: 'switch'; url: string }
  | { action: 'rejected'; url: string }
  | { action: 'ignored' };

/** Decode a query param by name from a `<scheme>://env?…` link. Null if absent/empty/undecodable. */
function parseQueryParam(link: string, name: string): string | null {
  const q = String(link || '').indexOf('?');
  if (q < 0) return null;
  for (const part of link.slice(q + 1).split('&')) {
    const eq = part.indexOf('=');
    if ((eq < 0 ? part : part.slice(0, eq)) !== name) continue;
    try {
      const decoded = decodeURIComponent((eq < 0 ? '' : part.slice(eq + 1)).replace(/\+/g, '%20')).trim();
      return decoded || null;
    } catch {
      return null; // malformed percent-encoding
    }
  }
  return null;
}

/** Decode the `url` query param from a `<scheme>://env?url=<encoded>` link. Null if absent/undecodable. */
function parseEnvTargetUrl(link: string): string | null {
  return parseQueryParam(link, 'url');
}

/** Resolve a `?to=`/`?env=` preset NAME against `envs` by label (case-insensitive). Null if no name given. */
function resolvePresetByName(link: string): { name: string; preset: { label: string; url: string } | undefined } | null {
  const name = parseQueryParam(link, 'to') ?? parseQueryParam(link, 'env');
  if (name === null) return null;
  const preset = (SHELL_CONFIG.envSwitcher?.envs ?? []).find((e) => e.label.toLowerCase() === name.toLowerCase());
  return { name, preset };
}

/** Structurally an env-switch deep link (`<scheme>://env…`) AND the switcher is enabled — the signal
 * events.ts uses to CONSUME the link (never forward an env link to the PWA). Inert (false) when the
 * feature is disabled/absent, so such a link simply falls through to the normal PWA deep-link path. */
export function isEnvDeepLink(link: string): boolean {
  return isEnvSwitcherEnabled() && hostOf(link) === 'env';
}

/**
 * PURE decision for an inbound `<scheme>://env?…` deep link — no dialogs, no side effects (unit-testable,
 * mirrors env-deeplink-security.test.ts). Two additive forms:
 *
 *  • `?to=<name>` (alias `?env=<name>`) — switch to a CONFIGURED preset by label, case-insensitive. A
 *    resolved preset is TRUSTED and BYPASSES the allowlist (it's a declared env, exactly like the manual
 *    switcher trusts its presets and only allowlists free-form "Other"). A name matching NO preset →
 *    `rejected` (NEVER switch, NEVER fall through to `?url=`). `to` WINS when both `to`/`env` present, and
 *    takes PRECEDENCE over `?url=` when both are present.
 *  • `?url=<encoded>` — free-form target, allowlist-GATED: MUST pass the SAME `isUrlAllowed` gate as the
 *    "Other" custom URL (anchored allowPattern, default-deny). Allowlisted → `switch`; else → `rejected`.
 *
 * Disabled feature / non-env link / neither param present (or malformed/undecodable) → `ignored`.
 */
export function decideEnvDeepLink(link: string): EnvDeepLinkDecision {
  if (!isEnvSwitcherEnabled() || hostOf(link) !== 'env') return { action: 'ignored' };
  // Preset-by-name takes precedence and bypasses the allowlist (trusted, configured env).
  const named = resolvePresetByName(link);
  if (named) {
    return named.preset ? { action: 'switch', url: named.preset.url } : { action: 'rejected', url: named.name };
  }
  const target = parseEnvTargetUrl(link);
  if (!target) return { action: 'ignored' };
  if (!isUrlAllowed(target)) return { action: 'rejected', url: target };
  return { action: 'switch', url: target };
}

/**
 * Handle an env-switch deep link end-to-end: confirm + apply via the SAME `applySwitch` path as a manual
 * switch (persist override → reload the WebView → refresh the banner, incl. the host-equals-default →
 * RESET semantics). A disallowed target shows a brief alert and NEVER switches; a malformed/disabled link
 * is ignored silently. Callers gate the WebView-ready timing (warm now / cold at handshake).
 */
export async function handleEnvDeepLink(link: string): Promise<void> {
  const decision = decideEnvDeepLink(link);
  if (decision.action === 'switch') {
    const preset = (SHELL_CONFIG.envSwitcher?.envs ?? []).find((e) => e.url === decision.url);
    await applySwitch(decision.url, preset ? preset.label : 'Shared link');
  } else if (decision.action === 'rejected') {
    await Dialogs.alert({ title: 'Not allowed', message: 'That environment link is not allowed for this app.', okButtonText: 'OK' });
  }
}

/** Free-form URL entry, gated by `allowPattern` (default-deny). Rejects a non-matching URL.
 *
 * The field is deliberately EMPTY — do NOT re-add a `defaultText: 'https://'` prefill. A URL is the one
 * input class users always PASTE, and a copied URL already carries its own scheme, so a prefill breaks
 * exactly the case this field exists for: iOS pastes at the caret (which sits AFTER the prefill), giving
 * `https://https://host` → rejected by `allowPattern` as "Not allowed". Typing masks the bug (you type the
 * host after the prefix), which is why it reads as "paste doesn't work". An empty field is also where iOS
 * offers Paste most readily — long-pressing a NON-empty field raises the cursor loupe, not the edit menu.
 * The `https://` hint lives in `message` instead, where it can't contaminate the value.
 */
async function promptOther(): Promise<void> {
  const res = await Dialogs.prompt({
    title: 'Custom environment',
    message: 'Enter or paste an allowed URL (https://…).',
    okButtonText: 'Next',
    cancelButtonText: 'Cancel',
    inputType: 'text',
  });
  if (!res?.result || !res.text) return;
  const url = res.text.trim();
  if (!isUrlAllowed(url)) {
    await Dialogs.alert({ title: 'Not allowed', message: 'That URL is not in the allowed pattern for this app.', okButtonText: 'OK' });
    return;
  }
  await applySwitch(url, 'Custom');
}
