import type { NativeKit } from '../core/NativeKit';

export type ImpactStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid';
export type NotifyType = 'success' | 'warning' | 'error';

export class HapticsModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('haptics');
  }

  impact(style: ImpactStyle = 'medium'): Promise<void> {
    return this.kit.invoke('haptics.impact', { style });
  }

  notify(type: NotifyType): Promise<void> {
    return this.kit.invoke('haptics.notify', { type });
  }
}
