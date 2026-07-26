import { NativeScriptConfig } from '@nativescript/core';

export default {
  // Stamped by `appwrap init` from appwrap.json
  id: 'cc.livx.hellowrap',
  appPath: 'app',
  appResourcesPath: 'App_Resources',
  ios: {
    discardUncaughtJsExceptions: false,
  },
  android: {
    v8Flags: '--expose_gc',
    markingMode: 'none',
  },
} as NativeScriptConfig;
