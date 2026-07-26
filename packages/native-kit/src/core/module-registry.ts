/**
 * Tiny, dependency-free, string-keyed registry for kit modules.
 *
 * Deliberately in-house (no di container): native-kit is bundled into consumer PWAs and
 * must stay ZERO-dependency. Keys are explicit strings — never constructor/parameter names —
 * because minification renames identifiers and would silently break name-based lookup.
 *
 * A future step lets out-of-repo "module packs" register their own client here; today it runs
 * in parallel with the eager `NativeKit` fields (same instances, no behaviour change).
 *
 * Typed access is via TypeScript declaration merging: augment {@link KitModuleRegistry} with
 * `name -> ModuleType` and {@link ModuleRegistry.getModule} returns the strongly-typed module.
 */

/** Augment via `declare module` to map a module name to its type (see NativeKit.ts). */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface KitModuleRegistry {}

export type ModuleFactory<T = unknown> = () => T;

export class ModuleRegistry {
  private instances = new Map<string, unknown>();
  private factories = new Map<string, ModuleFactory>();

  /** Register a module by string name — either a ready instance or a lazy factory
   * (called at most once, then memoized). Re-registering replaces the prior entry. */
  registerModule(name: string, instanceOrFactory: unknown | ModuleFactory): void {
    if (typeof instanceOrFactory === 'function') {
      this.factories.set(name, instanceOrFactory as ModuleFactory);
      this.instances.delete(name);
    } else {
      this.instances.set(name, instanceOrFactory);
      this.factories.delete(name);
    }
  }

  hasModule(name: string): boolean {
    return this.instances.has(name) || this.factories.has(name);
  }

  /** Currently-mounted module names, sorted. */
  moduleNames(): string[] {
    return [...new Set([...this.instances.keys(), ...this.factories.keys()])].sort();
  }

  /**
   * Typed, string-keyed lookup. STRICT by design: the ONLY public signature is keyed to
   * `keyof KitModuleRegistry`, so `getModule('billing')` is a COMPILE ERROR unless the billing pack's
   * kit client has been imported (its `declare module` augments the registry) — you get compile-time
   * verification + autocomplete of exactly the modules you've wired, never a runtime surprise. For a
   * genuinely dynamic name, use {@link getModuleUnsafe}.
   */
  getModule<K extends keyof KitModuleRegistry>(name: K): KitModuleRegistry[K];
  getModule(name: string): unknown {
    if (this.instances.has(name)) return this.instances.get(name);
    const factory = this.factories.get(name);
    if (factory) {
      const inst = factory(); // memoize once, then drop the factory
      this.instances.set(name, inst);
      this.factories.delete(name);
      return inst;
    }
    // Fail LOUD: a missing module must throw at the call site, never queue/return undefined.
    throw new Error(
      `[native-kit] module '${name}' is not registered. ` +
        `Mounted modules: [${this.moduleNames().join(', ')}]. ` +
        `Did you list its pack in modulePacks?`
    );
  }

  /** Escape hatch for a genuinely DYNAMIC module name (not a compile-time literal) — bypasses the
   * keyed check. Prefer {@link getModule}; reach for this only when the name isn't statically known. */
  getModuleUnsafe<T = unknown>(name: string): T {
    return (this.getModule as (n: string) => unknown)(name) as T;
  }
}
