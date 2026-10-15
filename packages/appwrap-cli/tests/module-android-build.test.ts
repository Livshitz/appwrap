import { expect, test } from 'bun:test';
import { androidGradleBlock, stampAndroidManifestReplace } from '../src/cli';

const BASE = 'android {\n  defaultConfig {}\n}\n';
const SNIP = "repositories { maven { url 'https://repo.example/maven' } }\nandroid { packaging { jniLibs { pickFirsts += ['**/libc++_shared.so'] } } }";

test('android.gradle snippets ride in the deps marker block; idempotent; none → unchanged', () => {
  const once = androidGradleBlock(BASE, ['a:b:1'], [SNIP]);
  expect(once).toContain('implementation "a:b:1"');
  expect(once).toContain("maven { url 'https://repo.example/maven' }");
  expect(androidGradleBlock(once, ['a:b:1'], [SNIP])).toBe(once);
  expect(androidGradleBlock(BASE, [], [SNIP])).not.toContain('dependencies {');
  expect(androidGradleBlock(once, [], [])).toBe(BASE);
  expect(androidGradleBlock(BASE, [], [])).toBe(BASE);
});

test('android.manifestReplace → tools:replace on <application> + xmlns:tools; idempotent; removed when none', () => {
  const src = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n<application android:label="X">\n</application>\n</manifest>';
  const out = stampAndroidManifestReplace(src, ['android:label', 'android:theme']);
  expect(out).toContain('xmlns:tools="http://schemas.android.com/tools"');
  expect(out).toContain('<application tools:replace="android:label,android:theme" android:label="X">');
  expect(stampAndroidManifestReplace(out, ['android:label', 'android:theme'])).toBe(out);
  expect(stampAndroidManifestReplace(out, [])).not.toContain('tools:replace');
});

test('SBG guard: an abandoned bundle file counts; the web app\'s own www/ files (ES modules) never do', async () => {
  const { sbgAbandoned } = await import('../src/cli');
  const log = [
    "t\tError processing '/x/platforms/android/app/src/main/assets/app/www/m/ink/ink-doc.js:' SyntaxError: 'import' and 'export' may appear only with 'sourceType: \"module\"' (9:0)",
    "t\tError processing '/x/platforms/android/app/src/main/assets/app/bundle.js:' TypeError: Cannot read properties of undefined (reading 'name')",
  ].join('\n');
  expect(sbgAbandoned(log)).toEqual([{ file: 'bundle.js', err: "TypeError: Cannot read properties of undefined (reading 'name')" }]);
});
