const webpack = require('@nativescript/webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require('path');

module.exports = (env) => {
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
