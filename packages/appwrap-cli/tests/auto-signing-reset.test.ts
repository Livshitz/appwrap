import { describe, expect, test } from 'bun:test';
import { pbxHasManualSigningResidue, resetPbxToAutomaticSigning } from '../src/cli';

// The auto lane (deploy/dev) drops platforms/ios when a prior `release`/`publish` left App-Store /
// manual signing in project.pbxproj — this guards the detector that triggers it.
describe('pbxHasManualSigningResidue', () => {
  test('detects fastlane-stamped Manual signing', () => {
    const pbx = `
			buildSettings = {
				CODE_SIGN_IDENTITY = "Apple Distribution";
				CODE_SIGN_STYLE = Manual;
				DEVELOPMENT_TEAM = RDYDSWE9RB;
				PRODUCT_BUNDLE_IDENTIFIER = cc.livx.blank;
			};`;
    expect(pbxHasManualSigningResidue(pbx)).toBe(true);
  });

  test('detects a match/App-Store PROVISIONING_PROFILE_SPECIFIER', () => {
    const pbx = `
			buildSettings = {
				PROVISIONING_PROFILE_SPECIFIER = "match AppStore cc.livx.blank";
				PRODUCT_BUNDLE_IDENTIFIER = cc.livx.blank;
			};`;
    expect(pbxHasManualSigningResidue(pbx)).toBe(true);
  });

  test('clean automatic-signed project is NOT flagged', () => {
    const pbx = `
			buildSettings = {
				CODE_SIGN_IDENTITY = "iPhone Developer";
				CODE_SIGN_STYLE = Automatic;
				DEVELOPMENT_TEAM = RDYDSWE9RB;
				PRODUCT_BUNDLE_IDENTIFIER = cc.livx.blank;
			};`;
    expect(pbxHasManualSigningResidue(pbx)).toBe(false);
  });

  test('empty / signing-free source is NOT flagged', () => {
    expect(pbxHasManualSigningResidue('')).toBe(false);
    expect(pbxHasManualSigningResidue('PRODUCT_BUNDLE_IDENTIFIER = cc.livx.blank;')).toBe(false);
  });
});

describe('resetPbxToAutomaticSigning', () => {
  const dirty = `
			buildSettings = {
				CODE_SIGN_IDENTITY = "Apple Distribution";
				"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";
				CODE_SIGN_STYLE = Manual;
				DEVELOPMENT_TEAM = RDYDSWE9RB;
				PROVISIONING_PROFILE_SPECIFIER = "match AppStore cc.livx.blank";
				PRODUCT_BUNDLE_IDENTIFIER = cc.livx.blank;
			};`;

  test('rewrites residue to automatic development signing', () => {
    const out = resetPbxToAutomaticSigning(dirty);
    expect(out).toContain('CODE_SIGN_STYLE = Automatic;');
    expect(out).not.toContain('CODE_SIGN_STYLE = Manual;');
    expect(out).not.toMatch(/PROVISIONING_PROFILE_SPECIFIER/);
    expect(out).not.toContain('Apple Distribution');
    expect(out).toContain('"Apple Development"');
    expect(out).toContain('DEVELOPMENT_TEAM = RDYDSWE9RB;');   // team preserved
    expect(out).toContain('PRODUCT_BUNDLE_IDENTIFIER = cc.livx.blank;'); // untouched
    // Result is clean, so the detector agrees.
    expect(pbxHasManualSigningResidue(out)).toBe(false);
  });

  test('is idempotent + a no-op on clean automatic source', () => {
    const clean = 'CODE_SIGN_STYLE = Automatic;\nDEVELOPMENT_TEAM = RDYDSWE9RB;';
    expect(resetPbxToAutomaticSigning(clean)).toBe(clean);
    expect(resetPbxToAutomaticSigning(resetPbxToAutomaticSigning(dirty))).toBe(resetPbxToAutomaticSigning(dirty));
  });
});
