import type { NativeKit } from '../core/NativeKit';

export class BiometricsModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('biometrics');
  }

  /** { available, type: 'face' | 'touch' | 'none' } */
  available(): Promise<{ available: boolean; type: string }> {
    return this.kit.invoke('biometrics.available');
  }

  /** Resolves { success } — rejects with DENIED on user cancel/failure. */
  authenticate(reason: string): Promise<{ success: boolean }> {
    return this.kit.invoke('biometrics.authenticate', { reason }, { timeoutMs: 60_000 });
  }
}
