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
  ],
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
  },
  teamId: 'YOUR_APPLE_TEAM_ID',
  storekitConfig: 'Products.storekit',
});
