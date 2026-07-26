// Module pack manifest for `__MODULE_NAME__` — scaffolded by `appwrap create-module`.
//
// A pack contributes one or more capabilities to a wrapper build exactly like the built-in modules do.
// This file default-exports { manifestSchemaVersion, modules } (a `PackModule`). The `handler` points
// at ./handler.ts and names the register fn the shell barrel calls at page load. Reference this pack
// from your app's appwrap.config.ts:
//
//   modulePacks: ['./path/to/__MODULE_NAME__'],   // this pack directory
//   modules: ['__MODULE_NAME__', ...],            // activate the module by name
//
// No type import here on purpose, so the scaffold has zero unresolved imports out of the box. The shape
// is validated by `@livx.cc/appwrap/testing`'s `validatePack` (and by the CLI at sync).
const pack = {
  manifestSchemaVersion: 1,
  modules: [
    {
      name: '__MODULE_NAME__',
      group: '__MODULE_NAME__',
      capabilities: { __MODULE_NAME__: { ios: true, android: true } },
      handler: { file: './handler.ts', fn: 'register__MODULE_PASCAL__Handlers' },
      // Optional: module-owned native source mirroring the App_Resources layout, copied into native/
      // ONLY when this module is active. Drop platform sources under ./native-src/__MODULE_NAME__/.
      nativeSrc: '__MODULE_NAME__',
    },
  ],
};
export default pack;
