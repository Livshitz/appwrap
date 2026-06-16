import type { NativeKit } from '../core/NativeKit';

/** System-level app actions: hand a URL to the OS, or open this app's settings page. */
export class AppModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('app');
  }

  /** Open a URL in the OS default handler (external browser, mail:, tel:, maps:, …). */
  openUrl(url: string): Promise<void> {
    return this.kit.invoke('app.openUrl', { url });
  }

  /** Open this app's page in the OS Settings app (to toggle permissions, etc.). */
  openSettings(): Promise<void> {
    return this.kit.invoke('app.openSettings');
  }
}
