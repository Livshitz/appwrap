import type { NativeKit } from '../core/NativeKit';

export class ToastModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('toast');
  }

  show(message: string, duration: 'short' | 'long' = 'short'): Promise<void> {
    return this.kit.invoke('toast.show', { message, duration });
  }
}
