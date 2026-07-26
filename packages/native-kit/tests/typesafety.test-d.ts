// Type-level regression guard for compile-time module typesafety + discoverability.
// A `typecheck` run (tsc --noEmit) fails if strictness regresses: each @ts-expect-error must
// suppress a REAL error, or tsc flags the unused directive.
import { kit } from '../src/index';
import { ModuleRegistry } from '../src/index';

// built-in: typed without any import (augmented into KitModuleRegistry)
kit.getModule('haptics').impact('light');

// unregistered / not-imported out-of-tree pack module → compile errors (strict keyed access)
// @ts-expect-error — 'bogus' is not a registered module name
kit.getModule('bogus');
// @ts-expect-error — 'billing' requires importing the billing pack's kit client first
kit.getModule('billing');

// the RAW registry is now strict too (was a loose escape-hatch overload)
const r = new ModuleRegistry();
// @ts-expect-error — raw getModule is keyed; dynamic strings are rejected
r.getModule('anything');
// the dynamic escape hatch is explicit + opt-in
const dyn: unknown = r.getModuleUnsafe('anything'); void dyn;
