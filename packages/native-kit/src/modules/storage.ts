import type { NativeKit } from '../core/NativeKit';

/**
 * Secure KV — native: Keychain/Keystore. No web fallback (capability 'none');
 * localStorage is not a secret store.
 */
export class SecureStorage {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('secureStorage');
  }

  get(key: string): Promise<string | null> {
    return this.kit.invoke('storage.secure.get', { key });
  }

  set(key: string, value: string): Promise<void> {
    return this.kit.invoke('storage.secure.set', { key, value });
  }

  remove(key: string): Promise<void> {
    return this.kit.invoke('storage.secure.remove', { key });
  }
}

/** Simple KV storage. Native: ApplicationSettings (survives WebView data clears). Web: localStorage. */
export class StorageModule {
  public readonly secure: SecureStorage;

  constructor(private kit: NativeKit) {
    this.secure = new SecureStorage(kit);
  }

  get capability() {
    return this.kit.capability('storage');
  }

  get<T = unknown>(key: string): Promise<T | null> {
    return this.kit.invoke('storage.get', { key });
  }

  set(key: string, value: unknown): Promise<void> {
    return this.kit.invoke('storage.set', { key, value });
  }

  remove(key: string): Promise<void> {
    return this.kit.invoke('storage.remove', { key });
  }

  /** Remove every kit-stored key (does not touch the secure store). */
  clear(): Promise<void> {
    return this.kit.invoke('storage.clear');
  }
}
