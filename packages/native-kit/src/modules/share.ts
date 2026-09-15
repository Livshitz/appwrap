import type { NativeKit } from '../core/NativeKit';

export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
}

/** A file to share. `base64` is raw base64 (no `data:` prefix) — JSON-safe over the bridge. */
export interface ShareFile {
  name: string; // filename incl. extension, e.g. 'invoice.pdf'
  mimeType: string; // e.g. 'application/pdf', 'image/png'
  base64: string;
}

/** How a share sheet ended. `completed` is false when the person dismissed it. `activity` is the OS
 * activity they picked when the platform reports one (iOS UIActivityType, e.g.
 * `com.apple.UIKit.activity.SaveToCameraRoll`); web `navigator.share` and the Android chooser never
 * name it. `undefined` from the call = a shell that predates this result (resolved on present). */
export interface ShareResult {
  completed: boolean;
  activity?: string;
}

/** What {@link ShareModule.saveToPhotos} resolves with. Never throws for a refusal: `saved:false` +
 * `reason` — 'denied' (the person said no / Settings forbids it), 'unsupported' (not an image or video,
 * or this shell/platform cannot write to the library: browsers, older native builds), 'failed'. */
export interface SaveToPhotosResult {
  saved: boolean;
  reason?: 'denied' | 'unsupported' | 'failed';
  message?: string;
}

export class ShareModule {
  constructor(private kit: NativeKit) {}

  /** Text/url share — iOS share sheet, Android chooser, web `navigator.share`. */
  get capability() {
    return this.kit.capability('share');
  }

  /** File share — distinct flag (a platform can share text but not files). */
  get filesCapability() {
    return this.kit.capability('shareFiles');
  }

  /** Direct save into the photo library — 'native' only in a shell that has the handler. Absent on web
   * (a browser cannot write to Photos) and on native builds that predate it: branch on this and fall
   * back to {@link files} (whose sheet offers "Save Image/Video"). */
  get saveToPhotosCapability() {
    return this.kit.capability('saveToPhotos');
  }

  /** Save ONE image or video straight into Photos (iOS add-only access, Android MediaStore) — no share
   * sheet. Resolves `{ saved:false, reason:'unsupported' }` without calling the shell when unavailable. */
  async saveToPhotos(file: ShareFile): Promise<SaveToPhotosResult> {
    await this.kit.ready().catch(() => {});
    if (this.saveToPhotosCapability !== 'native') return { saved: false, reason: 'unsupported', message: 'saving to Photos is not available here' };
    // No watchdog: the first call waits on the OS permission prompt.
    return this.kit.invoke('share.saveToPhotos', file, { timeoutMs: 'none' });
  }

  // Both resolve when the sheet is DISMISSED (not when it opens), so no watchdog: a person may take
  // their time picking a target, and a deadline could only false-timeout mid-interaction.
  share(payload: SharePayload): Promise<ShareResult | undefined> {
    return this.kit.invoke('share.share', payload, { timeoutMs: 'none' });
  }

  /** Share one or more files (iOS UIActivity / web `navigator.share({files})`). */
  files(files: ShareFile[], opts?: { title?: string; text?: string }): Promise<ShareResult | undefined> {
    return this.kit.invoke('share.files', { files, ...opts }, { timeoutMs: 'none' });
  }
}
