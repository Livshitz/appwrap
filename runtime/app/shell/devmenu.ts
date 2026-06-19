import { Device, Dialogs, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { SHELL_CONFIG } from './config';
import { SHELL_BUILD, reloadWebView } from './handlers';

/**
 * Shake-to-open developer menu (enabled in prod too, gated by `SHELL_CONFIG.devMenu`).
 * A shake raises a native action sheet → "App Info" shows non-sensitive diagnostics
 * (ids, versions, loader, remote host) including the running webapp's version vs. the
 * latest deployed — so you can tell at a glance whether the device got the update.
 */

/** Last version info the web side reported (native-kit's updates module). */
let webInfo: { current?: string; latest?: string; build?: string | number; updateAvailable?: boolean } = {};

export function startDevMenu(): void {
  // The web side (native-kit updates) pushes its version + the latest-deployed version here.
  bridge.register('app.reportWebVersion', (p: any) => {
    webInfo = p || {};
  });
  if (isIOS) startIOSShake();
  else if (isAndroid) startAndroidShake();
}

// ── shake detection (total acceleration magnitude in g incl. gravity, debounced) ──
const SHAKE_G = 1.8; // spike vs. ~1g rest
let shakeMm: any = null; // hold a ref so CoreMotion isn't GC'd
let firstSpikeAt = 0;
let spikes = 0;
let lastMenuAt = 0;

function onAccelMagnitude(g: number): void {
  if (g < SHAKE_G) return;
  const now = Date.now();
  if (now - lastMenuAt < 1500) return; // don't re-open right after a menu
  if (now - firstSpikeAt > 800) {
    firstSpikeAt = now; // start a fresh window
    spikes = 1;
    return;
  }
  if (++spikes >= 2) {
    spikes = 0;
    firstSpikeAt = 0;
    lastMenuAt = now;
    void showDevMenu();
  }
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
    const x = m.userAcceleration.x + m.gravity.x; // total accel in g (rest ≈ 1)
    const y = m.userAcceleration.y + m.gravity.y;
    const z = m.userAcceleration.z + m.gravity.z;
    onAccelMagnitude(Math.sqrt(x * x + y * y + z * z));
  }, 100);
}

function startAndroidShake(): void {
  const sm = Utils.android
    .getApplicationContext()
    .getSystemService(android.content.Context.SENSOR_SERVICE) as android.hardware.SensorManager;
  const accel = sm.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER);
  if (!accel) return;
  const G = 9.80665;
  const listener = new android.hardware.SensorEventListener({
    onAccuracyChanged() {},
    onSensorChanged(e: any) {
      const v = e.values;
      onAccelMagnitude(Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) / G);
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
      actions: ['App Info', 'Reload'],
    });
    if (action === 'App Info') await showInfo();
    else if (action === 'Reload') reloadWebView();
  } finally {
    menuOpen = false;
  }
}

async function showInfo(): Promise<void> {
  // Running web version: prefer what kit.updates reported, else read the page's embedded global
  // directly — so the line shows for any server-loader app exposing __APP_VERSION__, even if its
  // native-kit is too old to ship the updates module.
  const current = webInfo.current || (await readPageVersion());
  const lines = [
    `App: ${SHELL_CONFIG.name}`,
    `ID: ${SHELL_CONFIG.appId}`,
    `Shell: ${SHELL_CONFIG.version} (${SHELL_BUILD})`,
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
