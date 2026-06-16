# @livx.cc/native-kit

Isomorphic native-capabilities kit for PWAs — the **same API in the browser and inside an [appwrap](https://github.com/Livshitz/appwrap) native shell**. Zero dependencies.

```bash
bun add @livx.cc/native-kit   # or: npm i @livx.cc/native-kit
```

```ts
import { kit } from '@livx.cc/native-kit';

await kit.haptics.impact('medium');     // native vibration in the shell, no-op/web-fallback in a browser
const photo = await kit.photos.pick();  // native picker on device, <input type=file> on web
```

The kit detects whether it's running inside the appwrap shell and routes each call to the native bridge or a web fallback, so a single web build works everywhere. Capabilities advertise their real backing (`native` / `web` / `none`) so your UI can be honest about what's available.

Covers haptics, share, storage, notifications, OAuth, billing (IAP), health, geo, camera, photos, contacts, calendar, motion, reviews, and more.

**Full documentation, capability model, and the bridge protocol:** see the [appwrap README](https://github.com/Livshitz/appwrap#readme).

## License

MIT © Elya Livshitz
