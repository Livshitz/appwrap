import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

export interface NetworkStatus {
  online: boolean;
  /** 'wifi' | 'cellular' | 'none' | 'unknown' */
  type: string;
}

export class NetworkModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('network');
  }

  status(): Promise<NetworkStatus> {
    return this.kit.invoke('network.status');
  }

  onChange(cb: (status: NetworkStatus) => void): Unsubscribe {
    return this.kit.on('network.change', (p) => cb(p as NetworkStatus));
  }
}
