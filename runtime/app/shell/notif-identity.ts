/**
 * PURE payload → "who is this from" mapping for LOCAL notifications (no NativeScript
 * imports; bun-tested). Shared by the iOS communication-notification path and the
 * Android per-sender-channel path so both derive the same identity from the same rules.
 *
 * When a `sender` name is given it becomes the notification's "from" title and the
 * original `title` is demoted to the subtitle (dropped when it would just duplicate
 * the sender). `icon` (URL or data-URI) is the avatar / large icon. `useIdentity` is
 * true when either a sender or an icon is present — i.e. when the platform should
 * present a custom-sender notification instead of the plain host-app one.
 */

/** One tappable button on a rich notification. `deepLink` is where the tap lands. */
export interface NotifAction {
  id: string;
  title: string;
  deepLink?: string;
}

export interface NotifIdentityInput {
  title?: string;
  body?: string;
  sender?: string;
  icon?: string;
}

export interface NotifIdentity {
  /** Main display title — the sender name when provided, else the original title. */
  title: string;
  /** Original title demoted to subtitle ('' = omit). */
  subtitle: string;
  body: string;
  /** Display name for the communication sender / channel ('' = none). */
  senderName: string;
  /** Icon URL or data-URI for the avatar / large icon ('' = none). */
  iconUrl: string;
  /** True when a custom identity (sender and/or icon) should be applied. */
  useIdentity: boolean;
}

/**
 * The OS ceiling that actually renders: iOS shows 2 buttons on a collapsed banner (4 expanded),
 * Android 3. Three is the widest set every platform draws without silently dropping one.
 */
export const MAX_NOTIF_ACTIONS = 3;

/**
 * Normalize a caller's `actions` into at most {@link MAX_NOTIF_ACTIONS} well-formed buttons.
 * Entries with no id or no title are DROPPED rather than rendered as a blank button, and ids are
 * deduped — a repeated id would make two buttons indistinguishable to the tap router.
 */
export function notifActions(actions: unknown): NotifAction[] {
  if (!Array.isArray(actions)) return [];
  const seen = new Set<string>();
  const out: NotifAction[] = [];
  for (const raw of actions) {
    const a = raw as Partial<NotifAction> | null;
    const id = String(a?.id ?? '').trim();
    const title = String(a?.title ?? '').trim();
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const deepLink = a?.deepLink ? String(a.deepLink) : undefined;
    out.push(deepLink ? { id, title, deepLink } : { id, title });
    if (out.length >= MAX_NOTIF_ACTIONS) break;
  }
  return out;
}

export function notifIdentity(o: NotifIdentityInput): NotifIdentity {
  const title = String(o.title ?? '');
  const body = String(o.body ?? '');
  const senderName = o.sender ? String(o.sender) : '';
  const iconUrl = o.icon ? String(o.icon) : '';
  const useIdentity = !!(senderName || iconUrl);
  // A named sender becomes the "from" title; the original title is demoted to the
  // subtitle (dropped when it would merely repeat the sender name).
  const displayTitle = senderName || title;
  const subtitle = senderName && title && title !== senderName ? title : '';
  return { title: displayTitle, subtitle, body, senderName, iconUrl, useIdentity };
}

/**
 * DECORATION MUST NEVER COST THE NOTIFICATION.
 *
 * Everything a rich banner adds — a custom sound, hero artwork, the button CATEGORY, the
 * communication-style sender identity — is a nicety layered onto one alert. Each of those steps
 * calls into ObjC and each can throw (a rejected attachment, a category the center refuses, an
 * intent SpringBoard denies). Left unguarded, any one of those throws escapes `notifications.schedule`
 * and the user gets NOTHING — a cosmetic failure silently promoted to a dropped notification.
 * Run every decorative step through here: it degrades to `fallback` and says why.
 */
export function bestEffort<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    console.warn(`[appwrap] notification ${what} skipped — posting without it: ${String(e)}`);
    return fallback;
  }
}

/** Async twin of `bestEffort` for the steps that download (sound, artwork). */
export async function bestEffortAsync<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[appwrap] notification ${what} skipped — posting without it: ${String(e)}`);
    return fallback;
  }
}
