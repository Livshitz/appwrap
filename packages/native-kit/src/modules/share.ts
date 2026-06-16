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

  share(payload: SharePayload): Promise<void> {
    return this.kit.invoke('share.share', payload);
  }

  /** Share one or more files (iOS UIActivity / web `navigator.share({files})`). */
  files(files: ShareFile[], opts?: { title?: string; text?: string }): Promise<void> {
    return this.kit.invoke('share.files', { files, ...opts });
  }
}
