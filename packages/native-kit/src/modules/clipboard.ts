import type { NativeKit } from '../core/NativeKit';

export class ClipboardModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('clipboard');
  }

  copy(text: string): Promise<void> {
    return this.kit.invoke('clipboard.copy', { text });
  }

  read(): Promise<string | null> {
    return this.kit.invoke('clipboard.read');
  }
}
