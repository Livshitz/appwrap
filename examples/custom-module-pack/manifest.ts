// A real, working out-of-tree appwrap module pack: `confetti`. Contributes one capability with a
// register handler. Authored as a plain object (no type import) so it resolves standalone; the shape is
// validated by `@livx.cc/appwrap/testing`'s validatePack. Reference it from an app's appwrap.config.ts:
//   modulePacks: ['./examples/custom-module-pack'],  modules: ['confetti', ...]
const pack = {
  manifestSchemaVersion: 1,
  modules: [
    {
      name: 'confetti',
      group: 'confetti',
      capabilities: { confetti: { ios: true, android: true } },
      handler: { file: './handler.ts', fn: 'registerConfettiHandlers' },
    },
  ],
};
export default pack;
