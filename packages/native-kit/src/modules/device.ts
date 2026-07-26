import type { NativeKit } from '../core/NativeKit';

export interface DeviceInfo {
  model: string;
  os: string;
  osVersion: string;
  language: string;
  region?: string;
  manufacturer?: string;
  battery?: { level: number; charging: boolean };
}

export class DeviceModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('device');
  }

  info(): Promise<DeviceInfo> {
    return this.kit.invoke('device.info');
  }
}
