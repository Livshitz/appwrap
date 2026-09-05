/**
 * Rich-notification ARTWORK on iOS — turn an image URL (or data-URI) into a
 * `UNNotificationAttachment`.
 *
 * WHY THIS IS NOT JUST "pass the url": like sounds, iOS never fetches a notification attachment.
 * `UNNotificationAttachment` takes a *file URL* the app owns, validates it by extension/UTI, and
 * then MOVES it into its own store — so a `image: <url>` option that forwards the string renders
 * nothing at all, silently. Download once, cache under a hash of the URL, and hand the OS a path.
 *
 * The attachment is what makes a banner a card: iOS shows it as the thumbnail on a collapsed
 * banner and as the hero image when the banner is expanded. It is ALSO the only way a mini-app's
 * own artwork reaches the banner when the communication-notification path is unavailable (no
 * `com.apple.developer.usernotifications.communication` entitlement), which is why the
 * notification handler falls back to attaching the sender's icon.
 *
 * Every failure path returns null and the caller posts a plain banner — a card without its picture
 * is a cosmetic miss; a dropped notification is not.
 */
import { sha256Hex } from './sha256';

/** Artwork is decoration on a one-shot alert, not a download: never hold the schedule call open. */
const FETCH_TIMEOUT_MS = 10_000;

/** Extensions UNNotificationAttachment accepts for an image. Anything else is coerced to .png. */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'webp'];

/** `<app container>/Library/Caches/appwrap-notif`, created on demand. */
function mediaDir(): string | null {
  const caches = NSSearchPathForDirectoriesInDomains(
    NSSearchPathDirectory.CachesDirectory, NSSearchPathDomainMask.UserDomainMask, true
  );
  if (!caches || caches.count === 0) return null;
  const dir = `${caches.objectAtIndex(0)}/appwrap-notif`;
  const fm = NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(dir)) {
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, null);
  }
  return fm.fileExistsAtPath(dir) ? dir : null;
}

/** Best-effort extension from a URL path; falls back to png (which iOS sniffs happily). */
function extOf(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  return IMAGE_EXTS.includes(ext) ? ext : 'png';
}

/** Write bytes to `dest`; true when the file lands. */
function writeData(data: NSData | null, dest: string): boolean {
  if (!data || data.length === 0) return false;
  return data.writeToFileAtomically(dest, true);
}

/** Download to `dest`. Resolves false on any transport failure (offline, 404, timeout). */
function downloadTo(url: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const nsUrl = NSURL.URLWithString(url);
    if (!nsUrl) return resolve(false);
    const cfg = NSURLSessionConfiguration.defaultSessionConfiguration;
    cfg.timeoutIntervalForRequest = FETCH_TIMEOUT_MS / 1000;
    const session = NSURLSession.sessionWithConfiguration(cfg);
    const task = session.dataTaskWithURLCompletionHandler(nsUrl, (data, response, error) => {
      const status = (response as NSHTTPURLResponse)?.statusCode ?? 0;
      if (error || !data || (status && (status < 200 || status >= 300))) {
        console.warn(`[appwrap] notification image download failed (${status || error?.localizedDescription})`);
        return resolve(false);
      }
      resolve(writeData(data, dest));
    });
    task.resume();
  });
}

/**
 * Resolve an image URL / data-URI to a `UNNotificationAttachment`, or null to post without artwork.
 * `id` is the attachment identifier (unique per notification content).
 */
export async function resolveAttachment(image: string, id: string): Promise<UNNotificationAttachment | null> {
  const value = String(image ?? '').trim();
  if (!value) return null;
  const dir = mediaDir();
  if (!dir) return null;

  const isData = value.startsWith('data:');
  const ext = isData ? (/^data:image\/(\w+)/.exec(value)?.[1] ?? 'png').toLowerCase() : extOf(value);
  const dest = `${dir}/${sha256Hex(value).slice(0, 32)}.${IMAGE_EXTS.includes(ext) ? ext : 'png'}`;

  const fm = NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(dest)) {
    let ok = false;
    if (isData) {
      const comma = value.indexOf(',');
      const b64 = comma >= 0 ? value.slice(comma + 1) : '';
      ok = !!b64 && writeData(
        NSData.alloc().initWithBase64EncodedStringOptions(b64, NSDataBase64DecodingOptions.IgnoreUnknownCharacters),
        dest
      );
    } else if (/^https?:\/\//i.test(value)) {
      ok = await downloadTo(value, dest);
    }
    if (!ok) return null;
  }

  try {
    // iOS MOVES the file into its own attachment store, so hand it a COPY — otherwise the cache
    // entry vanishes and every later notification re-downloads (or, worse, finds a half-moved file).
    const copy = `${dir}/use-${id}-${Date.now()}.${dest.split('.').pop()}`;
    if (!fm.copyItemAtPathToPathError(dest, copy, null)) return null;
    return UNNotificationAttachment.attachmentWithIdentifierURLOptionsError(
      id, NSURL.fileURLWithPath(copy), null, null
    );
  } catch (e) {
    console.warn('[appwrap] notification attachment rejected', String(e));
    return null;
  }
}
