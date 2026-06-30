import { Device, Dialogs, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { SHELL_CONFIG } from './config';
import { SHELL_BUILD, reloadWebView, getReportedWebVersion } from './handlers';

/**
 * Shake-to-open developer menu (enabled in prod too, gated by `SHELL_CONFIG.devMenu`).
 * A shake raises a native action sheet with: "App Info" — non-sensitive diagnostics (ids, versions,
 * loader, remote host) including the running webapp's version vs. the latest deployed, so you can tell
 * at a glance whether the device got the update; "Reload"; and "Toggle Debug" — a generic hook that
 * dispatches the `appwrap:toggleDebug` DOM event so the web app can flip its OWN debug UI.
 * The web version status is reported via the always-on `app.reportWebVersion` handler
 * (in handlers.ts) — independent of this menu — and read here when the menu is shown.
 */

export function startDevMenu(): void {
  if (isIOS) startIOSShake();
  else if (isAndroid) startAndroidShake();
}

// ── shake detection — deliberate, robust against incidental motion (walking, bumps) ──
// A real "shake to open" is a sustained back-and-forth: several HARD spikes, close together, that
// REVERSE direction each time. Walking/jostle produces occasional same-direction spikes with gaps —
// so we require (a) a high threshold, (b) direction reversal between consecutive spikes, and (c) a
// short inter-spike gap that RESETS the count if you pause. The bar is a firm wrist-shake, not a step.
const SHAKE_G = 2.3; // hard spike vs. ~1g rest (was 1.8 — too low, walking cleared it)
const SHAKE_SPIKES = 4; // direction-reversing spikes needed (≈2 full back-and-forth shakes)
const SHAKE_GAP_MS = 400; // max gap between spikes; a longer pause resets the streak
const MENU_DEBOUNCE_MS = 1500; // don't re-open right after a menu
let shakeMm: CMMotionManager | null = null; // hold a ref so CoreMotion isn't GC'd
let spikes = 0;
let lastSpikeAt = 0;
let lastSpikeDir = 0; // sign of the dominant axis at the last spike; reversal = real shake
let lastMenuAt = 0;

/** @param g total accel magnitude in g (rest ≈ 1)
 *  @param dir sign (+1/-1) of the dominant-axis acceleration — used to detect back-and-forth reversal */
function onAccelMagnitude(g: number, dir: number): void {
  if (g < SHAKE_G) return;
  const now = Date.now();
  if (now - lastMenuAt < MENU_DEBOUNCE_MS) return;
  // A spike that's too soon after the last counts as the SAME thrust, not a new one — ignore it so a
  // single hard jolt's ringing doesn't rack up the count.
  if (now - lastSpikeAt < 80) return;
  // Reset the streak unless this spike continues a fast, direction-reversing sequence.
  if (now - lastSpikeAt > SHAKE_GAP_MS || dir === lastSpikeDir) {
    spikes = 1;
  } else {
    spikes++;
  }
  lastSpikeAt = now;
  lastSpikeDir = dir;
  if (spikes >= SHAKE_SPIKES) {
    spikes = 0;
    lastSpikeAt = 0;
    lastSpikeDir = 0;
    lastMenuAt = now;
    void showDevMenu();
  }
}

/** Sign of the largest-magnitude component — the axis the shake is thrusting along. */
function dominantDir(x: number, y: number, z: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  const v = ax >= ay && ax >= az ? x : ay >= az ? y : z;
  return v >= 0 ? 1 : -1;
}

function startIOSShake(): void {
  // Poll `mm.deviceMotion` on a JS timer — CoreMotion's queue-handler block is fragile under
  // NativeScript (can silently stop firing on-device); mirrors the motion.start handler.
  const mm = CMMotionManager.new();
  if (!mm.deviceMotionAvailable) return; // no sensors (simulator)
  shakeMm = mm;
  mm.deviceMotionUpdateInterval = 0.1;
  mm.startDeviceMotionUpdates();
  setInterval(() => {
    const m = mm.deviceMotion;
    if (!m) return; // first sample not ready
    const ux = m.userAcceleration.x, uy = m.userAcceleration.y, uz = m.userAcceleration.z;
    const x = ux + m.gravity.x; // total accel in g (rest ≈ 1) — magnitude includes gravity
    const y = uy + m.gravity.y;
    const z = uz + m.gravity.z;
    // Direction from gravity-free userAcceleration (gravity is constant → would mask the back-and-forth).
    onAccelMagnitude(Math.sqrt(x * x + y * y + z * z), dominantDir(ux, uy, uz));
  }, 100);
}

function startAndroidShake(): void {
  const sm = Utils.android
    .getApplicationContext()
    .getSystemService(android.content.Context.SENSOR_SERVICE) as android.hardware.SensorManager;
  const accel = sm.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER);
  if (!accel) return;
  const G = 9.80665;
  // Low-pass gravity estimate so we can derive gravity-free direction (mirrors iOS userAcceleration);
  // the raw accelerometer includes gravity, which is constant and would mask the back-and-forth.
  const grav = [0, 0, 0];
  const alpha = 0.8;
  const listener = new android.hardware.SensorEventListener({
    onAccuracyChanged() {},
    onSensorChanged(e: android.hardware.SensorEvent) {
      const v = e.values;
      grav[0] = alpha * grav[0] + (1 - alpha) * v[0];
      grav[1] = alpha * grav[1] + (1 - alpha) * v[1];
      grav[2] = alpha * grav[2] + (1 - alpha) * v[2];
      const lx = v[0] - grav[0], ly = v[1] - grav[1], lz = v[2] - grav[2]; // linear (gravity-free)
      onAccelMagnitude(Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) / G, dominantDir(lx, ly, lz));
    },
  });
  sm.registerListener(listener, accel, android.hardware.SensorManager.SENSOR_DELAY_UI);
}

// ── menu + info ──────────────────────────────────────────────────────
let menuOpen = false;
async function showDevMenu(): Promise<void> {
  if (menuOpen) return; // sensor keeps firing while the sheet is up — don't stack dialogs
  menuOpen = true;
  try {
    const action = await Dialogs.action({
      title: SHELL_CONFIG.name,
      message: 'Developer menu',
      cancelButtonText: 'Cancel',
      actions: ['App Info', 'Reload', 'Toggle Debug'],
    });
    if (action === 'App Info') await showInfo();
    else if (action === 'Reload') reloadWebView();
    else if (action === 'Toggle Debug') toggleWebDebug();
  } finally {
    menuOpen = false;
  }
}

/** Native build id — iOS `CFBundleVersion` / Android `versionCode`. This is the number the store shows
 * (TestFlight/Play), so it lets a tester confirm exactly which uploaded build is running. */
function nativeBuild(): string {
  try {
    if (isIOS) return String(NSBundle.mainBundle.objectForInfoDictionaryKey('CFBundleVersion'));
    if (isAndroid) {
      const ctx = Utils.android.getApplicationContext();
      return String(ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode);
    }
  } catch (e) {
    console.warn('AppWrap: devmenu nativeBuild read failed', e);
  }
  return '?';
}

async function showInfo(): Promise<void> {
  // Running web version: prefer what kit.updates reported, else read the page's embedded global
  // directly — so the line shows for any server-loader app exposing __APP_VERSION__, even if its
  // native-kit is too old to ship the updates module.
  const webInfo = getReportedWebVersion();
  const current = webInfo.current || (await readPageVersion());
  const lines = [
    `App: ${SHELL_CONFIG.name}`,
    `ID: ${SHELL_CONFIG.appId}`,
    `Version: ${SHELL_CONFIG.version} (build ${nativeBuild()})`, // native CFBundleVersion/versionCode = the store build id
    `Shell: ${SHELL_BUILD}`,
    `Platform: ${isIOS ? 'iOS' : 'Android'} ${Device.osVersion}`,
    `Loader: ${SHELL_CONFIG.loader}`,
  ];
  if (SHELL_CONFIG.loader === 'server') lines.push(`Remote: ${safeHost(SHELL_CONFIG.serverUrl)}`);

  const build = webInfo.build ? ` · build ${webInfo.build}` : '';
  lines.push(`Web version: ${current || 'unknown'}${build}`);
  if (webInfo.latest && current && webInfo.latest !== current) lines.push(`⚠️ Update available: ${webInfo.latest} — Reload to apply`);
  else if (webInfo.latest) lines.push('✓ Up to date');

  Dialogs.alert({ title: 'App Info', message: lines.join('\n'), okButtonText: 'Close' });
}

/** Generic dev hook: dispatch a DOM event the running web app can listen for to flip its OWN debug UI
 * (`window.addEventListener('appwrap:toggleDebug', …)`). No-op for apps that don't listen — the shell
 * has no app-specific debug state of its own, so it just relays the intent. */
function toggleWebDebug(): void {
  bridge
    .evalJs("window.dispatchEvent(new CustomEvent('appwrap:toggleDebug'))")
    .catch((e) => console.log('[appwrap] toggleDebug dispatch failed:', e));
}

/** Read the running page's embedded version directly from the WebView: `window.__APP_VERSION__`,
 * then a `<meta name="app-version">` fallback. '' if neither is present (or eval fails). */
async function readPageVersion(): Promise<string> {
  try {
    const v = await bridge.evalJs(
      'window.__APP_VERSION__ || document.querySelector(\'meta[name="app-version"]\')?.getAttribute("content") || ""'
    );
    return v ? String(v) : '';
  } catch {
    return '';
  }
}

/** Host[:port] only — strips scheme, path, query, fragment AND any `user:pass@` userinfo, so no
 * credentials or tokens embedded in the URL ever surface in diagnostics. */
function safeHost(url: string): string {
  const afterScheme = String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = afterScheme.split(/[/?#]/)[0]; // drop path/query/fragment
  return authority.split('@').pop() || authority; // drop userinfo
}
