/**
 * Shell config — stamped by `appwrap init` from appwrap.json.
 */
export const SHELL_CONFIG = {
  appId: 'cc.livx.hellowrap',
  name: 'Hello AppWrap',
  version: '0.1.0',
  /** Entry file inside the bundled www/ folder. */
  entry: 'index.html',
  /** Page + status bar background while the WebView boots. */
  backgroundColor: '#0b1020',
  /** Boot-time native chrome color (status bar / safe areas), from `appwrap.json.themeColor` or the
   * PWA manifest `theme_color`. Empty = leave the root un-tinted (page backgroundColor shows through).
   * Applied at boot via the same root-view tint `kit.ui.syncThemeColor()` uses at runtime. */
  themeColor: '',
  /** 'light' = white status bar icons. */
  statusBarStyle: 'light' as 'light' | 'dark',
  /** Supported orientation (config > manifest). Drives the iOS AppDelegate orientation mask at boot
   * (which overrides Info.plist) + is stamped to Android `screenOrientation`. '' = free rotation. */
  orientation: '' as '' | 'portrait' | 'landscape' | 'any',
  /** Android only (experimental). true = WebView draws edge-to-edge under transparent bars +
   * safe-area insets injected as `--saie-*` CSS vars; false = bars show the page backgroundColor. */
  edgeToEdge: false,
  /** Loader: 'app' = app:// scheme handler (stable origin, ES modules, bundled www); 'file' = debug
   * fallback; 'server' = load `serverUrl` live (dev HMR over LAN, or pointing at a deployed URL). */
  loader: 'app' as 'app' | 'file' | 'server',
  /** Live URL loaded when loader === 'server' (e.g. http://192.168.x.x:5173 dev, or a deployed https URL). */
  serverUrl: '',
  /** Absolute backend origin for an offline (app://) PWA whose API/WS calls were originally same-origin.
   * Injected to the page as `window.__APPWRAP_BACKEND_ORIGIN__`; empty = same-origin (browser default). */
  backendOrigin: '',
  /** The app's own custom URL scheme (`appwrap.json.urlScheme`), the one registered for deep links.
   * Surfaced to the page as `window.__APPWRAP__.scheme` so a webapp can build its own deep-link URLs;
   * empty = no scheme configured, and the `scheme` key is OMITTED from `__APPWRAP__` (see `detectEnv`). */
  urlScheme: '' as string,
  /** Debug/dev mode: keep the screen awake (no auto-lock while foreground) + WebView inspectable
   * (Safari Web Inspector / chrome://inspect). Set true by `appwrap deploy`; never in store builds. */
  debug: false,
  /** Value written to `localStorage.DEBUG` in debug mode so the PWA logger goes verbose ('*' = all). */
  debugLog: '*',
  /** Shake-to-open developer menu (App Info / Reload). On by default, including store builds. */
  devMenu: true,
  /** Neutralize `navigator.serviceWorker.register` in the native shell (a SW serves stale caches and
   * fights the app:// handler / remote-update detection). On by default; set false to opt out and keep
   * the SW (e.g. for in-WebView web-push). See `serviceWorkerGuardJs`. */
  neutralizeServiceWorker: true,
  /** iOS App-Bound Domains (from `appwrap.json.appBoundDomains`). When non-empty the shell sets
   * `WKWebViewConfiguration.limitsNavigationsToAppBoundDomains = true` — Apple's gate for running a
   * service worker in the WKWebView (the same hosts are stamped to Info.plist `WKAppBoundDomains`).
   * RESTRICTS the WebView to these domains, so only for single-origin apps. Empty = no restriction. */
  appBoundDomains: [] as string[],
  /** Open external-origin navigations (`<a>` to another origin, incl. `target="_blank"`, and
   * `window.open(...)`) in the OS default browser (Safari / Chrome) instead of inside the shell
   * WebView — regular-native-app behavior. Same-origin SPA navigation is untouched. Off by default.
   * See `externalNavGuardJs`. */
  openNewWindowsInBrowser: false,
  /** Remote push configured, per platform (iOS aps-environment entitlement / Android FCM). Drives the
   * `push` capability flag at runtime by platform — off unless `appwrap.json.push` enables it, so an
   * un-provisioned build honestly reports 'none' (and a personal-team iOS build keeps `pushIos:false`). */
  pushIos: false,
  pushAndroid: false,
  /** Optional backend URL that the shell POSTs the device token to NATIVELY as soon as it's acquired —
   * `{ token, platform: 'ios'|'android' }`. Native HTTP avoids the WKWebView `app://` cross-origin/CORS
   * wall, so a token reaches your server without any WebView fetch. Empty = the app handles sending. */
  pushRegistrationUrl: '',
  /** iOS only. Extra points to lift the WebView ABOVE the reported keyboard height on focus. iOS 26
   * reports a keyboard ~this-many points TALLER than it draws on warm re-focus (a phantom accessory
   * reservation), which would leave a black strip between the resized WebView and the real keys.
   * Lifting extra makes the page cover that strip (the keyboard hides the thin bottom row of content).
   * Default 82. Set 0 for NO extra lift (input sits flush at the reported height; the strip may show). */
  iosKeyboardExtraLift: 82,
  /** Runtime env-switcher (loader:'server'). `enabled` is the resolved kill-switch (config block
   * present AND not `enabled:false`); when false the menu action, banner, and boot override are all
   * inert. `envs` = declared presets; `allowPattern` = anchored regex gating "Other" (default-deny
   * when ''). Stamped by `appwrap init`/`sync` — see `stampShellConfig`. */
  envSwitcher: { enabled: false, envs: [] as { label: string; url: string }[], allowPattern: '' },
  /** TCC-gated web APIs this build DECLARED (active modules + the config's `permissions{}`) — what the
   * document-start capability guard exposes to the page. NOT the same question as "is the Info.plist
   * usage string present": the plist also carries the webview baseline (NSCameraUsageDescription is
   * stamped in every build so WKWebView's `<input type="file">` "Take Photo" can't TCC-kill the
   * process), and an app that never asked for the camera must still not be handing `getUserMedia` to
   * whatever page it renders. Stamped by `appwrap init`/`sync` — see `stampShellConfig`. */
  webCaps: { camera: false, microphone: false, geolocation: false },
};
