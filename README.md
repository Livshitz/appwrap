# appwrap 🎁

[![npm: @livx.cc/appwrap](https://img.shields.io/npm/v/@livx.cc/appwrap?label=%40livx.cc%2Fappwrap)](https://www.npmjs.com/package/@livx.cc/appwrap)
[![npm: @livx.cc/native-kit](https://img.shields.io/npm/v/@livx.cc/native-kit?label=%40livx.cc%2Fnative-kit)](https://www.npmjs.com/package/@livx.cc/native-kit)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Take any PWA and ship it as a real native app — offline-bundled, with native capabilities — without giving up the web.

## Wrap your PWA in one prompt

You don't even have to read the docs. appwrap ships an [`AGENTS.md`](./AGENTS.md), so your coding agent (Claude Code, Cursor, …) can do the whole thing. From **your PWA repo**, hand it:

> **Wrap this PWA as a native iOS app with appwrap, following https://github.com/Livshitz/appwrap/blob/main/AGENTS.md**

It adds the deps, writes your `appwrap.json`, scaffolds the native project, and builds to your device — surfacing any missing prerequisites (Bun, NativeScript CLI, Xcode/CocoaPods) as it goes.

Prefer to drive it yourself? → [Get started](#get-started--wrap-your-own-pwa).

---

- **`@livx.cc/native-kit`** — isomorphic SDK. Same import, same calls in a plain browser and inside the native shell. Every domain reports a `capability` flag (`'native' | 'web' | 'none'`); a method then either fulfils it, degrades to a benign no-op, or throws a typed `KitError('UNSUPPORTED')` when there's no honest fallback — you branch on the flag (see [Capabilities on web vs native](#capabilities-on-web-vs-native)). Zero dependencies.
- **`@livx.cc/appwrap`** — CLI. `appwrap init` scaffolds a native wrapper around a built PWA from a single `appwrap.json`.
- **Runtime** (`runtime/`) — the native shell template: NativeScript-based, WKWebView/WebView hosting the bundled PWA, speaking the appwrap bridge protocol v1 (JSON envelopes; real `WKScriptMessageHandler` on iOS). Bundled into the CLI — you never install it directly.
- **`examples/hello-pwa`** — test PWA: a capability dashboard exercising every kit module in both contexts.

## Requirements

- **[Bun](https://bun.sh)** — appwrap is bun-first; the `appwrap` binary runs as TypeScript via bun. (`curl -fsSL https://bun.sh/install | bash`)
- **NativeScript CLI** — required for any simulator/device/store build (`appwrap init` / `sync` work *without* it; `ns run`/`ns build` need it): `npm i -g nativescript`, then run `ns doctor ios` / `ns doctor android` to verify the toolchain and fix anything it flags.
- **iOS builds** — [Xcode](https://apps.apple.com/app/xcode/id497799835) + Command Line Tools (`xcode-select --install`; provides `xcodebuild` and `devicectl` for on-device installs) and **CocoaPods** (`brew install cocoapods`). A physical-device install also needs the device registered to your Apple team — set `teamId` in `appwrap.json`.
- **Android builds** — [Android Studio](https://developer.android.com/studio) + JDK 17, with `ANDROID_HOME` exported (e.g. `export ANDROID_HOME=$HOME/Library/Android/sdk`).

## Get started — wrap your own PWA

```bash
# 1 · add appwrap to your existing PWA project
bun add -d @livx.cc/appwrap @livx.cc/native-kit

# 2 · describe the app in one file (minimal — see appwrap.json reference below)
echo '{ "id": "com.you.app", "name": "My App", "version": "1.0.0", "pwaDist": "dist" }' > appwrap.json

# 3 · build your PWA, scaffold the native wrapper, run it
bun run build                            # your existing build → dist/
bunx appwrap init                        # generates native/ from appwrap.json
cd native && npm install && ns run ios   # or: ns run android

# iterate — rebuild the PWA and re-sync (fast path, no full regen)
bunx appwrap sync
```

Then call native capabilities straight from your web code — the same import is a no-op-safe web fallback in a plain browser:

```ts
import { kit } from '@livx.cc/native-kit';

await kit.ready();
if (kit.haptics.capability === 'native') await kit.haptics.impact('medium');
```

> **Device / App Store builds:** add your Apple Team ID to `appwrap.json` (`"teamId": "XXXXXXXXXX"`) — `init` / `sync` stamp it into the Xcode project. `native/` is a disposable artifact: **gitignore it** and regenerate any time (see [Updating & extending](#updating--extending-the-wrapper)).

## Try the example (from this repo)

```bash
bun install
bun run build:hello
cd examples/hello-pwa
bun ../../packages/appwrap-cli/src/cli.ts init   # runs the CLI straight from source
cd native && npm install && ns run ios

# run it as a plain PWA in the browser instead:
cd .. && bun run serve                           # http://localhost:5180
```

## appwrap.json

```json
{
  "id": "cc.livx.hellowrap",
  "name": "Hello AppWrap",
  "version": "0.2.0",
  "entry": "index.html",
  "backgroundColor": "#0b1020",
  "statusBarStyle": "light",
  "pwaDist": "dist",
  "urlScheme": "hellowrap",
  "permissions": {
    "location": "Why this app needs location…",
    "photos": "Why this app needs photo access…",
    "faceid": "Why this app uses Face ID…"
  }
}
```

`urlScheme` registers a deep-link scheme (`hellowrap://…` → `kit.lifecycle.onDeepLink`).
`modules` (optional) is an opt-in capability allow-list — **present** → only the listed capabilities
(plus always-on core) are advertised, permissioned, and compiled into the shell, so an app that
doesn't use a capability doesn't bundle its handler or request its permission (lighter store build);
**absent** → every capability is active (back-compat). Each capability's permissions/background-modes/
native-deps are declared in its own manifest entry (`runtime/app/shell/capabilities.manifest.ts`) and
the CLI collects+dedups them across the active set.
`permissions` stamps iOS usage strings (keys: `location`, `photos`, `camera`, `microphone`, `faceid`,
`calendar`, `contacts`, `motion`). Without `modules` it's the source of which perms are added; with
`modules` it only **overrides** a module's default usage copy. Only declared/active ones reach Info.plist.
`storekitConfig` (optional) points at a `.storekit` file (relative to the project) and wires it into
the iOS scheme so `kit.billing` resolves products locally — no App Store Connect needed. Applies only
when launched from Xcode (sim or device-from-Xcode), not a standalone `devicectl` sideload.

## Using the kit in your PWA

```ts
import { kit } from '@livx.cc/native-kit';

await kit.ready();              // adapter resolution + handshake
kit.is.native                   // true inside the shell
kit.haptics.capability          // 'native' | 'web' | 'none'
await kit.haptics.impact('light');
await kit.share.share({ url: 'https://…' });
await kit.share.files([{ name: 'card.png', mimeType: 'image/png', base64 }]); // share files, not just links
await kit.storage.set('k', { any: 'json' });
await kit.storage.secure.set('token', 's3cret');   // Keychain / Keystore
await kit.toast.show('hi');
await kit.ui.setStatusBarStyle('light');
await kit.device.info();
await kit.clipboard.copy('text');
await kit.notifications.schedule({ title: 'Hi', delaySec: 5 });
await kit.biometrics.authenticate('Prove it');
await kit.oauth.authorize({ url: authUrl, callbackScheme: 'myapp' }); // system-browser OAuth (iOS, opt-in `oauth` module) — for providers (Google…) that reject embedded WebViews; → { url } callback to exchange + signInWithCredential
await kit.geo.current();
await kit.photos.pick();
await kit.network.status();
await kit.ui.safeArea(); await kit.ui.setBrightness(0.5); await kit.ui.keepAwake(true);
await kit.screen.orientation.lock('landscape');   // pin orientation; .unlock() to free; .onChange(cb)
await kit.ui.alert({ message: 'Hi' });            // native dialogs: alert/confirm/action
await kit.ui.action({ options: ['A', 'B'] });     // → chosen index | null
kit.ui.syncThemeColor();                          // <meta name=theme-color> → native chrome
await kit.reviews.requestReview();                // StoreKit in-app review
const stopGeo = await kit.geo.watch((pos) => {}); // streaming position
const stopMotion = await kit.motion.watch((s) => {}); // accelerometer+gyro ~10Hz
await kit.contacts.pick();                        // CNContactPicker (no permission needed)
await kit.calendar.createEvent({ title: 'Demo' }); // EventKit (needs `calendar` permission)
await kit.photos.capture();                       // camera (UNSUPPORTED on simulator)
await kit.photos.pick({ dataUrl: true });          // also returns a downscaled JPEG data URL
await kit.notifications.schedule({ title: 'Tap', deepLink: 'myapp://item/7' }); // tap → onDeepLink

// Live media — mic / camera / speaker bridged into the PWA. getUserMedia is a Web API; the
// shell unlocks it (grants the WebView capture permission) and tunes the native audio session.
kit.media.available;                              // secure-context + mediaDevices present?
const stream = await kit.media.getUserMedia({ audio: true, video: true });
await kit.media.configureAudio('playback');        // iOS: play over the silent switch / background
await kit.media.devices();                         // enumerate input/output devices

// In-app purchases / subscriptions — ONE API across web and native. The kit owns the
// native store flow (iOS StoreKit 1, Android Play Billing); on the web it dispatches to
// a checkout provider you wire (Stripe/Paddle/custom). Same calls everywhere:
await kit.billing.products(['pro_monthly']);       // localized title + price
await kit.billing.purchase('pro_monthly');         // Stripe on web · StoreKit/Play on mobile
await kit.billing.restore();
await kit.billing.entitlements();                  // from the configured server-of-record
await kit.billing.manageSubscriptions();           // OS surface / Stripe Billing Portal
kit.billing.onTransaction((receipt) => {});        // renewals / out-of-band buys (native)
// configure once, platform-agnostic — the module picks the right path per platform:
import { HttpValidator, HttpBillingProvider } from '@livx.cc/native-kit';
kit.billing.configure({
  // web: how a purchase happens (your backend mints a Stripe Checkout Session, etc.)
  webProvider: new HttpBillingProvider({ baseUrl: 'https://your-backend/api/billing' }),
  // native: who confirms the receipt — one generic validator covers RevenueCat/IAPHUB
  validator:   new HttpValidator({ validateUrl: 'https://your-backend/iap/validate' }),
});
kit.billing.capability // 'native' (store shell) · 'web' (provider wired) · 'none'

kit.lifecycle.onResume(() => {});
kit.lifecycle.onDeepLink((url) => {});
kit.network.onChange((s) => {});
```

## Capabilities on web vs native

The kit is isomorphic: write `kit.<domain>.<call>()` once and it runs everywhere. What
differs is *how* a domain is fulfilled — and the kit is honest about it via the
`capability` flag, never by pretending. Three outcomes:

| `capability` | meaning | what a call does |
|---|---|---|
| `'native'` | served by the shell (StoreKit, CoreLocation, Keychain…) | the real native thing |
| `'web'` | served by a Web Platform API or a provider you wired | the web equivalent |
| `'none'` | no honest fallback in this environment | benign no-op **or** throws `KitError('UNSUPPORTED')` |

**Parity where it exists, honesty where it doesn't.** Many domains map cleanly to the web
(`geo`→Geolocation, `clipboard`→Clipboard, `notifications`→Notifications, `share`→Web Share,
`photos`→`<input type=file>`, `media`→getUserMedia, `network`, `dialogs`, `themeColor`, `motion`, `device`,
`shareFiles`→`navigator.share({files})`, `orientation`→Screen Orientation API). Some
have no web counterpart and report `'none'`: a read-style call no-ops (e.g. `ui.setStatusBarStyle`),
while a call that *can't* be faked throws `UNSUPPORTED` rather than lie (`storage.secure.*`,
`biometrics.authenticate`, `reviews.requestReview`, `calendar`). One is honest about partial
reach: web `orientation.lock` rejects with `UNSUPPORTED` outside fullscreen (desktop / iOS
Safari). Always branch on `capability` (or `try/catch`) — never assume a platform.

### Billing is the same one API on every platform

Purchases can't "no-op", so billing gets first-class web support instead of a dead end. The
kit owns the **native** store flow (iOS StoreKit 1, Android Play Billing); on the **web** you
plug in a checkout **provider** and the *same* `kit.billing.*` calls dispatch to it:

```ts
import { kit, HttpBillingProvider, HttpValidator } from '@livx.cc/native-kit';

kit.billing.configure({
  webProvider: new HttpBillingProvider({ baseUrl: '/api/billing' }), // web: Stripe/Paddle/custom
  validator:   new HttpValidator({ validateUrl: '/api/iap/validate' }), // native: receipt check
});

await kit.billing.purchase('pro_monthly'); // Stripe Checkout on web · StoreKit/Play on mobile
await kit.billing.entitlements();           // your backend is the server-of-record everywhere
```

Two orthogonal seams, both swappable, both plain HTTP (no vendor SDK):

- **`BillingProvider`** — *how a purchase happens* on the web. `HttpBillingProvider` POSTs to your
  backend; if it returns a hosted-checkout `url` (Stripe Session) the page redirects and the
  entitlement surfaces via `entitlements()` on the way back; if it returns `entitlements` inline,
  the call resolves immediately. One config fits Stripe / Paddle / LemonSqueezy / anything.
- **`BillingValidator`** — *who confirms the entitlement* (the server-of-record). Used to validate
  the native store receipt; one generic `HttpValidator` covers RevenueCat / IAPHUB / custom.

`kit.billing.capability` is `'native'` in a store shell, `'web'` once a provider is wired, else
`'none'`. A **native shell never silently falls back to web checkout** (App Store / Play policy);
on the web with no provider, billing calls throw an actionable `UNSUPPORTED` telling you to
`configure({ webProvider })`. See `examples/hello-pwa` for a working web provider.

## Protocol v1 (web ⇄ shell)

JSON-string envelopes:
`{v:1, id, kind:'request', method:'haptics.impact', params}` →
`{v:1, id, kind:'response', result|error:{code,message}}`, plus `{v:1, kind:'event', event, payload}`.
Transports: iOS `webkit.messageHandlers.appwrap` (real script message handler), Android `window.prompt()` tunnel intercepted in `WebChromeClient.onJsPrompt` (synchronous push — no polling, no compiled bridge class). Native → web via `window.__appwrapDeliver(json)`.

## Updating & extending the wrapper

The generated `native/` is a **disposable build artifact** (the Expo "continuous native generation"
model), not source you hand-edit. Everything in it is reproduced from `appwrap.json` + the PWA
manifest + your overrides — so **gitignore `native/`** and regenerate it any time:

```bash
# upgrade the framework, then regenerate the shell — like `expo prebuild`
bun update @livx.cc/native-kit @livx.cc/appwrap
appwrap init        # idempotent: re-running regenerates an appwrap-managed wrapper in place
cd native && npm install && ns run ios
```

- **`init` vs `sync`** — `init` (re)generates the whole shell; use it after a framework upgrade,
  a config change, or a fresh `git clone` (where `native/` doesn't exist). `sync` is the fast path
  for iterating on your PWA — it re-copies the built web bundle + re-stamps config without touching
  the shell. (Live HMR against your dev server is the `dev-live-reload` lane.)
- **Idempotent & guarded** — re-`init` regenerates a managed wrapper freely; it refuses to clobber a
  directory it didn't generate (no `.appwrap-version`) unless you pass `--force`.
- **Version skew is loud, not silent** — `native/.appwrap-version` records the CLI/shell/protocol
  that generated the wrapper, and `kit.ready()` throws `UNSUPPORTED` if a stale shell's protocol
  doesn't match the kit's. A kit method backed by a capability the shipped shell lacks still reports
  `capability: 'none'` rather than crashing.
- **Custom / legacy native code — `overrides/`** — the declarative config covers the common cases
  (permissions, scheme, icons, version, entitlements-to-come). For anything it can't express, drop
  raw native files in `appwrap.overrides/` (configurable via `appwrap.json.overrides`); they're
  copied **over** the generated wrapper, last, so they win — and survive every regenerate.
- **Store readiness, emitted not hand-placed** — `init` stamps the artifacts a review needs so they
  survive regeneration: `PrivacyInfo.xcprivacy` (required-reason APIs), `ITSAppUsesNonExemptEncryption`
  (`usesNonExemptEncryption` in config), and a **monotonic build number** (`CFBundleVersion` /
  Android `versionCode` from `buildNumber`, derived from `version` by default) separate from the
  user-facing marketing version.

## Service workers & background work

**Web Workers keep working** — `new Worker(...)` / SharedWorker / AudioWorklet run normally in the
native shell, so offloading compute to a thread needs no changes.

**Service workers don't** — `navigator.serviceWorker` can't register under the shell's `app://` origin
(a WKWebView platform limit, same as every webview wrapper). That's fine, because a SW's jobs move to
stronger native lanes: offline app-shell is already served by the shell; **push → `kit.push`** (APNs/FCM);
**background sync → a native task lane** (BGTaskScheduler / WorkManager); API caching → in-app + the shell
backend proxy. The shell no-ops SW registration in native so you don't have to gate it per app (this also
disables the web-push path, since web-push needs a SW).

**Designing a PWA for appwrap:** treat SW / web-push as web-only progressive enhancements behind one
`kit.is.native` check, and **parameterize your backend origin** (`injected ?? location.origin`) rather than
assuming same-origin — that makes the native wrap nearly free.

## Tests

```bash
bun test packages/                                  # kit unit tests
~/.maestro/bin/maestro test examples/hello-pwa/maestro/smoke.yaml   # native smoke (simulator)
```

## Status / roadmap

- [x] kit core + web adapter + appwrap adapter
- [x] iOS shell — 25 domains: haptics, share (text + files), storage (kv + secure/Keychain), toast,
      status bar, device, clipboard, notifications (+badge), biometrics, geolocation (current + watch),
      photos, network, screen (safe-area/brightness/keep-awake/orientation-lock), dialogs (alert/
      confirm/action), StoreKit review, theme-color sync, motion sensors, contacts picker, calendar,
      camera capture, app (openUrl/openSettings), in-app browser (SFSafariViewController),
      billing (StoreKit 1 IAP/subscriptions — pluggable validator: RevenueCat/IAPHUB/custom;
      a real purchase needs an Xcode-run `.storekit` config or App Store Connect sandbox products)
- [x] modular capabilities — each capability self-declares its perms/bg-modes/deps in a manifest
      (`capabilities.manifest.ts`); `appwrap.json.modules` opt-in allow-list lets the CLI strip
      unused handlers/permissions from the store build (collect+dedup across the active set)
- [x] `health` (steps) — opt-in module: iOS HealthKit + Android Health Connect (both the system
      store, Wear-inclusive, survive an app kill; `TYPE_STEP_COUNTER` fallback). `kit.health.count/
      watch`. iOS device-verified (iPhone 13 Pro Max); Android builds+launches clean on the API-35
      emulator. Health Connect needs compileSdk 36 + minSdk 26 + a Kotlin coroutine shim — all
      module-owned (manifest entitlement/perms/deps + `runtime/modules-native/`), zero app `overrides/`
- [x] billing is cross-platform on ONE API: the same `kit.billing.*` calls drive the native
      store on a shell and a pluggable web checkout provider (`HttpBillingProvider` → Stripe/
      Paddle/custom) in the browser — verified on web in `examples/hello-pwa` (badge `web`,
      products/buy/entitlements all work via the provider; the native bridge is never touched)
- [x] events: lifecycle (pause/resume), deep links (custom URL scheme), network change
- [x] deep-link routing demo — `examples/hello-pwa` is a multi-page app (hash router:
      Home/Profile/Settings/Item/:id); `hellowrap://item/7` deep-links straight into the page
      (`maestro/deeplink-nav.yaml`, green on both platforms)
- [x] CLI `init` / `sync` — stamps id, name, version, iOS permissions, URL scheme, Android permissions
- [x] managed model (Expo-CNG-style) — `native/` is generated & disposable: idempotent guarded `init`,
      `.appwrap-version` provenance stamp, `kit.ready()` protocol assertion (loud version skew),
      `overrides/` pure-native escape hatch, manifest→config fallback (name/background), CI regenerates
      `native/` with `init` (not `sync`) on a fresh checkout
- [x] store-readiness emitters — `PrivacyInfo.xcprivacy` (May-2024 hard-reject gap),
      `ITSAppUsesNonExemptEncryption`, monotonic build number (`CFBundleVersion`/`versionCode` split
      from marketing version). Release/AAB build path + capabilities→entitlements (push/universal
      links) still open — see `.tmp/tasks/store-readiness.md`, `framework-extensibility.md`
- [x] Maestro full-capability flow (`examples/hello-pwa/maestro/demo-full.yaml`)
- [x] Android shell — full parity except reviews (Play In-App Review, deferred): motion
      (SensorManager), browser (Chrome Custom Tabs), contacts (ACTION_PICK + ContactsContract),
      calendar (CalendarContract insert), camera (MediaStore capture). Transport: prompt() tunnel
      via onJsPrompt; PWA served from `https://appwrap.local` (shouldInterceptRequest, ES modules OK);
      Maestro flows `demo-android.yaml` + `android-parity.yaml` green on API 35 emulator
- [ ] remote push (APNs/FCM lane)
- [x] custom URL scheme handler (`app://local`) — unmodified ES-module PWAs load with a stable
      origin (`loader: 'file'` kept as a debug fallback in appwrap.json)
- [x] icon + launch-screen generation from the PWA manifest (`sips`, zero deps)
- [x] CI/CD templates — GH Actions (PR build + tag→TestFlight) + fastlane (match, ASC API key)
- [ ] OTA updates
