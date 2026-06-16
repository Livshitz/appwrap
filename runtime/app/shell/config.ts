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
  /** 'light' = white status bar icons. */
  statusBarStyle: 'light' as 'light' | 'dark',
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
  /** Debug/dev mode: keep the screen awake (no auto-lock while foreground) + WebView inspectable
   * (Safari Web Inspector / chrome://inspect). Set true by `appwrap deploy`; never in store builds. */
  debug: false,
  /** Value written to `localStorage.DEBUG` in debug mode so the PWA logger goes verbose ('*' = all). */
  debugLog: '*',
  /** Remote push configured, per platform (iOS aps-environment entitlement / Android FCM). Drives the
   * `push` capability flag at runtime by platform — off unless `appwrap.json.push` enables it, so an
   * un-provisioned build honestly reports 'none' (and a personal-team iOS build keeps `pushIos:false`). */
  pushIos: false,
  pushAndroid: false,
};
