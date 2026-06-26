const webpack = require('@nativescript/webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require('path');

module.exports = (env) => {
  // Force CommonJS bundle output. @nativescript/ios >=9 flips @nativescript/webpack to ESM (.mjs),
  // which makes @nativescript/core install its polyfills EAGERLY at bundle eval (matchMedia /
  // media-query-list) — and that eager install crashes on launch ("Cannot read properties of
  // undefined" in installPolyfills→matchMedia), white-screening/killing the app at startup. CommonJS
  // uses the lazy polyfill path (the long-stable NS mode). appwrap runtime uses no import.meta, so
  // CommonJS is safe. Remove only once the NS-core ESM eager-install bug is fixed upstream.
  env = env || {};
  env.commonjs = true;
  webpack.init(env);

  webpack.chainWebpack((config) => {
    // Ship the PWA bundle inside the app package
    config.plugin('CopyWww').use(CopyWebpackPlugin, [
      {
        patterns: [
          {
            // Staged OUTSIDE appPath (see CLI copyPwa) so NS loaders never touch the web
            // app's CSS/assets — copied verbatim into the bundle's `www`, served at app://.
            from: path.resolve(__dirname, 'www-src'),
            to: 'www',
            noErrorOnMissing: true, // server loader: no bundled www (loads serverUrl live)
            force: true,
          },
        ],
      },
    ]);
  });

  return webpack.resolveConfig();
};
