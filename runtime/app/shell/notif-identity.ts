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
