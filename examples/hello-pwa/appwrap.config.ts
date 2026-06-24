import { defineConfig } from '@livx.cc/appwrap/config';

export default defineConfig({
  id: 'cc.livx.hellowrap',
  name: 'Hello AppWrap',
  version: '0.2.0',
  entry: 'index.html',
  backgroundColor: '#0b1020',
  statusBarStyle: 'light',
  pwaDist: 'dist',
  urlScheme: 'hellowrap',
  modules: [
    'notifications', 'biometrics', 'geo', 'photos', 'camera', 'media',
    'motion', 'contacts', 'calendar', 'reviews', 'billing', 'health', 'scanner', 'speech', 'oauth',
    'tracking', 'appleSignIn', 'backgroundTask',
  ],
  // Permitted headless background-task ids (iOS BGTaskSchedulerPermittedIdentifiers). The 'sync' tile
  // registers + schedules this id.
  backgroundTasks: ['sync'],
  permissions: {
    location: 'Demo: show your coordinates in the capability dashboard',
    photos: 'Demo: pick a photo to prove native picker access',
    faceid: 'Demo: authenticate with Face ID',
    calendar: 'Demo: add a calendar event from the capability dashboard',
    camera: 'Demo: capture a photo to prove native camera access',
    microphone: 'Demo: record audio to prove native microphone access',
    contacts: 'Demo: pick a contact to prove native contacts access',
    motion: 'Demo: count your steps',
    speechRecognition: 'Demo: transcribe your voice in the speech tile',
    tracking: 'Demo: ask App Tracking Transparency consent and read the IDFA',
  },
  // ATT tracking domains (iOS) — declared in PrivacyInfo.xcprivacy when the `tracking` module is
  // active. Demo placeholder; a real app lists the hosts its analytics/ad SDKs contact while tracking.
  trackingDomains: ['analytics.example.com'],
  teamId: 'YOUR_APPLE_TEAM_ID',
  // Remote push (APNs). Gated here (NOT the modules list). iOS stamps the `aps-environment`
  // entitlement → requires a PAID Apple team that can hold the Push capability (a free personal
  // team would break signing). 'development' = debug/TestFlight; the demo's own public relay
  // (examples/push-relay, appwrap-push-relay.bodify.bod.ee) sends the actual test push once
  // register() returns a token, so the Push tile works end-to-end on a provisioned build.
  push: { enabled: true, apsEnvironment: 'development' },
  storekitConfig: 'Products.storekit',
});
