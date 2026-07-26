// Neutralizer stub — intentionally EMPTY. Do NOT add `declare const X: any` here.
//
// Real iOS framework types come from the @nativescript/types-ios references in `references.d.ts`.
// This file exists ONLY so `appwrap sync` copies it over `native/app/shell/ios-frameworks.d.ts`,
// overwriting a stale PRE-`references.d.ts` generated relic of the same name. That relic declared
// every framework symbol as `declare const X: any` (a VALUE); once handlers annotate params with the
// real types (e.g. `mm: CMMotionManager`), the value-shadow makes the build throw TS2749 ("refers to
// a value, used as a type"). Shipping this empty stub self-heals any native/ on the next sync.
export {};
