# __MODULE_NAME__ — appwrap module pack

A **module pack** is a self-contained directory that contributes native capabilities to an appwrap
wrapper build, exactly like the built-in modules do — without patching appwrap itself.

## Layout

```
__MODULE_NAME__/
├── manifest.ts                 # default-exports { manifestSchemaVersion, modules } (a PackModule)
├── handler.ts                  # exports register__MODULE_PASCAL__Handlers() — wires the bridge method(s)
└── native-src/                 # optional module-owned native source (copied in ONLY when active)
    └── __MODULE_NAME__/         # mirrors the App_Resources layout (App_Resources/iOS, /Android, …)
```

- **manifest.ts** declares the module: its `name`, `group`, `capabilities`, and the `handler`
  ({ file, fn }) the shell calls at page load. Optionally `nativeSrc` (a `native-src/<name>/` dir),
  `ios`/`android` blocks (permissions / entitlements / gradleDeps).
- **handler.ts** imports shell APIs via the sanctioned `@livx.cc/appwrap/runtime/app/shell/<name>`
  specifier (e.g. `bridge`). The generator rewrites these to relative `./` on staging. A handler may
  also import `@nativescript/core`, node builtins, or pack-relative `./…` paths — but it must NOT reach
  into appwrap internals via `../` escapes or other `@livx.cc/appwrap/…` deep imports.

## Use it in an app

In your app's `appwrap.config.ts`:

```ts
export default {
  // …
  modulePacks: ['./path/to/__MODULE_NAME__'],   // local dir, or an npm package name
  modules: ['__MODULE_NAME__' /* , …other active modules */],
};
```

Then `appwrap sync` stages the pack's handler + native source into the generated `native/` shell, and
the capability is advertised to the web side in the handshake.

## Validate

```ts
import { assertValidPack } from '@livx.cc/appwrap/testing';
await assertValidPack(new URL('.', import.meta.url).pathname);
```
