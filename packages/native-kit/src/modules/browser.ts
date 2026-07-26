import type { NativeKit } from '../core/NativeKit';

export interface BrowserOptions {
  /** Tint for the in-app browser chrome (hex, e.g. "#4b0082").
   * iOS → SFSafariViewController.preferredControlTintColor; Android → toolbar color. */
  toolbarColor?: string;
}

/** In-app browser: iOS SFSafariViewController, Android Chrome Custom Tabs, web new tab.
 * Keeps the user inside the app (vs `app.openUrl`, which leaves for the OS handler). */
export class BrowserModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('browser');
  }

  /** Present an in-app browser for the URL. Resolves once it has been presented. */
  open(url: string, opts: BrowserOptions = {}): Promise<void> {
    return this.kit.invoke('browser.open', { url, ...opts });
  }
}
