import { SHELL_CONFIG } from './config';

/**
 * Framework globals injected at document-start, BEFORE the page's own scripts. `__APPWRAP_BACKEND_ORIGIN__`
 * is the absolute backend origin (empty on web / when unset) — exposed for any page code that wants it
 * (e.g. the SDK's ingestUrl override for the WebSocket, which can't be proxied). Relative HTTP backend
 * calls (`/api/*`, `/functions/*`) are NOT rewritten here — the native app:// scheme handler PROXIES
 * them to the backend so they stay same-origin to the WebView (no CORS dependency). Empty = no-op on web.
 */
export const APPWRAP_GLOBALS_JS = `
window.__APPWRAP_BACKEND_ORIGIN__=${JSON.stringify(SHELL_CONFIG.backendOrigin || '')};
window.__APPWRAP_DEBUG__=${SHELL_CONFIG.debug ? 'true' : 'false'};
(function(){
  if (!window.__APPWRAP_DEBUG__ || window.__appwrapLogPatched) return;
  window.__appwrapLogPatched = true;
  // Dev: turn the PWA's own logger verbose (common localStorage.DEBUG convention) so the forwarded
  // [appwrap-web] stream isn't empty. Set before the app's modules read it (document-start).
  try { localStorage.setItem('DEBUG', ${JSON.stringify(SHELL_CONFIG.debugLog || '*')}); } catch (e) {}
  // Debug only: forward the WebView's console + uncaught errors to the native log so they're
  // readable HEADLESSLY (\`appwrap logs ios\` → devicectl --console). iOS posts to a message handler
  // → NSLog; on Android webkit.messageHandlers is absent (caught) — use logcat / onConsoleMessage.
  var post = function(s){ try { window.webkit.messageHandlers.appwrapLog.postMessage(s); } catch (e) {} };
  post('[boot] web console forwarding active @ ' + (location && location.href || ''));
  ['log','debug','info','warn','error'].forEach(function(lvl){
    var orig = console[lvl] ? console[lvl].bind(console) : function(){};
    console[lvl] = function(){
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          try { parts.push(typeof a === 'string' ? a : JSON.stringify(a)); } catch (e) { parts.push(String(a)); }
        }
        post('[' + lvl + '] ' + parts.join(' '));
      } catch (e) {}
      orig.apply(null, arguments);
    };
  });
  window.addEventListener('error', function(e){ post('[uncaught] ' + (e.message || e) + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0)); });
  window.addEventListener('unhandledrejection', function(e){ var r = e.reason; post('[rejection] ' + ((r && (r.stack || r.message)) || r)); });
})();`;

/**
 * Reject `getUserMedia` for a capability this build did NOT declare (no Info.plist usage key), in JS at
 * document-start — BEFORE the request reaches WebKit's native capture path. This is the ONLY layer that
 * can stop the crash: to set up a capture session WebKit asks TCC to authorize the camera/mic, and on iOS
 * a request for a privacy class with no usage string is a HARD PROCESS-KILL (not a catchable error). That
 * request fires around the WKUIDelegate decision, so a native `deny` there can't prevent it — but if the
 * call is rejected in JS, WebKit's native path is never entered. `camera`/`microphone` = the declared
 * flags (iOS: presence of NSCamera/NSMicrophoneUsageDescription). Patches the prototype so a page can't
 * dodge it via `MediaDevices.prototype.getUserMedia.call(...)`. Declared capabilities pass straight through.
 */
export function mediaCaptureGuardJs(camera: boolean, microphone: boolean): string {
  return `(function(){
  var proto = window.MediaDevices && window.MediaDevices.prototype;
  if (!proto || !proto.getUserMedia || window.__appwrapGumGuard) return;
  window.__appwrapGumGuard = true;
  var DECLARED = { video: ${!!camera}, audio: ${!!microphone} };
  function missing(c){
    var m = [];
    if (c && c.video && !DECLARED.video) m.push('camera');
    if (c && c.audio && !DECLARED.audio) m.push('microphone');
    return m;
  }
  var orig = proto.getUserMedia;
  proto.getUserMedia = function(constraints){
    var m = missing(constraints);
    if (m.length) return Promise.reject(new DOMException(
      m.join(' & ') + ' not available (capability not enabled for this app)', 'NotAllowedError'));
    return orig.call(this, constraints);
  };
})();`;
}

/**
 * Neutralize `navigator.serviceWorker.register` inside the native shell at document-start, so a
 * consumer PWA doesn't have to hand-gate its own SW. Inside the shell a service worker is at best
 * useless and at worst HARMFUL: a cache-first SW serves a stale bundle and fights the native app://
 * scheme handler / loader:'server' remote-update detection.
 *
 * SEMANTICS (and why):
 *  - We patch ONLY `register` — leave `navigator.serviceWorker` (and its `.ready`/`.controller`/event
 *    surface) in place. Removing `serviceWorker` entirely would lie to feature-detection: `if
 *    ('serviceWorker' in navigator)` stays true (the SW *API* exists; this WebView genuinely supports
 *    it), but no SW ever activates because every `register` is a no-op. Well-written PWAs treat
 *    register() as best-effort.
 *  - `register()` returns a PROMISE THAT NEVER RESOLVES (and never rejects). This is the gentlest of
 *    the three options: resolving with a fake registration would hand back a lying object whose
 *    `.update()`/`.unregister()`/`.active` consumers might call; rejecting fires `.catch()` paths that
 *    many apps log as an error or retry in a loop. A pending promise means `.then(...)` simply never
 *    runs (no controller, no stale cache — the desired end state) and `.catch(...)` never fires (no
 *    uncaught error, no error spam). `navigator.serviceWorker.ready` is likewise a never-settling
 *    promise per spec until a SW is ready, so leaving it pending matches normal "no SW yet" behavior.
 *  - We ALSO best-effort `getRegistrations().then(rs => rs.forEach(r => r.unregister()))` to tear down
 *    any SW a PREVIOUS web/PWA session already installed for this origin (otherwise a pre-existing
 *    cache-first SW keeps serving stale content even though we now block new registrations).
 *  - Touches `navigator.serviceWorker` ONLY. `Worker` / `SharedWorker` are deliberately untouched —
 *    compute-offload workers legitimately run in a WebView.
 *
 * NOTE: neutralizing the SW also disables WEB push (web push needs a SW). That's expected and fine —
 * native push is the `remote-push` lane (APNs/FCM), and the push-prompt UI already gates on
 * `kit.is.native`. No push code needs to change.
 *
 * `enabled` = the resolved neutralize flag (SHELL_CONFIG.neutralizeServiceWorker, default true in
 * native; set false via appwrap config to opt out and leave the SW fully intact). Idempotent via a
 * window guard so double-injection (e.g. Android's onPageStarted fallback) is a no-op.
 */
export function serviceWorkerGuardJs(enabled: boolean): string {
  if (!enabled) return '';
  return `(function(){
  var sw = navigator.serviceWorker;
  if (!sw || !sw.register || window.__appwrapSwGuard) return;
  window.__appwrapSwGuard = true;
  // Tear down any SW a prior web session installed for this origin (stops it serving a stale cache).
  try { sw.getRegistrations && sw.getRegistrations().then(function(rs){ rs.forEach(function(r){ try { r.unregister(); } catch (e) {} }); }).catch(function(){}); } catch (e) {}
  // register() → a promise that never settles: .then() never runs (no SW activates) and .catch()
  // never fires (no error spam / retry loops). Feature-detection ('serviceWorker' in navigator) and
  // .ready stay truthful — the API exists, nothing ever becomes ready.
  sw.register = function(){ return new Promise(function(){}); };
})();`;
}

/**
 * Native-feel injection shared by both CustomWebViews. Suppresses the "it's a
 * web page" tells: pinch / double-tap zoom, long-press callout & selection,
 * overscroll glow/bounce, and iOS text auto-resizing. Injected at document
 * start (and re-applied on DOMContentLoaded — at document-start <head> may be
 * empty). Idempotent via a window guard, so double-injection is a no-op.
 *
 * Text selection is preserved inside inputs / [contenteditable] so forms and
 * chat composers still work. Native zoom controls / overscroll mode are also
 * turned off at the WebView level by each platform (belt-and-suspenders).
 */
const NATIVE_FEEL_CSS = [
  'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}',
  'html,body{overscroll-behavior:none;touch-action:manipulation}',
  '*{-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}',
  ':where(:not(input,textarea,[contenteditable],[contenteditable] *)){-webkit-user-select:none;user-select:none}',
].join('');

/** Accessibility-standard reduced-motion reset — collapse animation/transition durations to ~0 and
 * stop infinite loops (animation-iteration-count:1). Injected only when the env hint is set. */
const REDUCE_MOTION_CSS =
  '*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;' +
  'transition-duration:.001ms!important;scroll-behavior:auto!important}';

export const NATIVE_FEEL_JS = `(function(){
  if (window.__appwrapNativeFeel) return;
  window.__appwrapNativeFeel = true;
  function apply(){
    var head = document.head || document.documentElement;
    var vp = document.querySelector('meta[name=viewport]');
    if (!vp){ vp = document.createElement('meta'); vp.setAttribute('name','viewport'); head.appendChild(vp); }
    var c = vp.getAttribute('content') || 'width=device-width, initial-scale=1';
    if (!/user-scalable\\s*=\\s*no/.test(c)) c += ', maximum-scale=1, user-scalable=no';
    // viewport-fit=cover makes env(safe-area-inset-*) resolve to real notch /
    // home-indicator insets — the WebView owns the safe areas (contentInset .never).
    if (!/viewport-fit/.test(c)) c += ', viewport-fit=cover';
    vp.setAttribute('content', c);
    if (!document.getElementById('__appwrap_feel')){
      var s = document.createElement('style'); s.id = '__appwrap_feel';
      s.textContent = ${JSON.stringify(NATIVE_FEEL_CSS)};
      head.appendChild(s);
    }
    // Reduced-motion / software-GPU (emulator) safety net: neutralize infinite CSS animations &
    // long transitions — they're free on a real GPU but continuously re-composite on the emulator's
    // software rasterizer (host-CPU burn) and fight the OS reduce-motion setting. Gated on the env
    // hint (see env.ts) so production on real devices is untouched; apps can still override.
    var env = window.__APPWRAP__ || {};
    if ((env.reduceMotion || env.isEmulator) && !document.getElementById('__appwrap_reduce_motion')){
      var rm = document.createElement('style'); rm.id = '__appwrap_reduce_motion';
      rm.textContent = ${JSON.stringify(REDUCE_MOTION_CSS)};
      head.appendChild(rm);
    }
  }
  apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  // Pinch-zoom on iOS fires gesture* even with user-scalable=no in some builds.
  document.addEventListener('gesturestart', function(e){ e.preventDefault(); }, { passive: false });
})();`;
