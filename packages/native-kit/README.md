# @livx.cc/native-kit

Isomorphic native-capabilities kit for PWAs — the **same API in the browser and inside an [appwrap](https://github.com/Livshitz/appwrap) native shell**. Zero dependencies.

```bash
bun add @livx.cc/native-kit
```

```ts
import { kit } from '@livx.cc/native-kit';

await kit.haptics.impact('medium');     // native vibration in the shell, no-op/web-fallback in a browser
const photo = await kit.photos.pick();  // native picker on device, <input type=file> on web
```

### Analytics context

`kit.context()` returns one flat, vendor-neutral property bag (client taxonomy, app version/build, install source, device, push permission, …) — spread it straight into your analytics super-properties. Native-only fields degrade gracefully on web. First-party & non-tracking: the install id is iOS IDFV / an Android UUID, never IDFA/GAID.

```ts
import { kit } from '@livx.cc/native-kit';
mixpanel.register(await kit.context());
// → { client: 'native-ios', platform: 'ios', app_version: '1.0.3',
//     install_source: 'testflight', device_model: 'iPhone15,3', push_permission: 'granted', … }
```

The kit detects whether it's running inside the appwrap shell and routes each call to the native bridge or a web fallback, so a single web build works everywhere. Capabilities advertise their real backing (`native` / `web` / `none`) so your UI can be honest about what's available.

Covers haptics, share, storage, notifications, OAuth, billing (IAP), health, geo, camera, photos, contacts, calendar, motion, reviews, tracking (iOS App Tracking Transparency), and more.

**Full documentation, capability model, and the bridge protocol:** see the [appwrap README](https://github.com/Livshitz/appwrap#readme).

## License

MIT © Elya Livshitz
