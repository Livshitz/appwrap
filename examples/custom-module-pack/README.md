# custom-module-pack (`confetti`) — example appwrap module pack

A minimal, real module pack you can copy. It contributes one capability, `confetti`, with a single
bridge method `confetti.fire`.

```
custom-module-pack/
├── manifest.ts   # default-exports { manifestSchemaVersion, modules }
└── handler.ts    # exports registerConfettiHandlers() → bridge.register('confetti.fire', …)
```

Use it from an app's `appwrap.config.ts`:

```ts
export default {
  modulePacks: ['./examples/custom-module-pack'],
  modules: ['confetti'],
};
```

Validate it: `import { assertValidPack } from '@livx.cc/appwrap/testing'`.
