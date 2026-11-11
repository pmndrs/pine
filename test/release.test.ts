import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore: a plain script, without types
import { ahead, bumpOf, nextVersion } from "../scripts/version.mjs";

test("release: the next version follows from the commits since the last one", () => {
	// What the commit messages call for.
	assert.equal(bumpOf("Update README\n--\nFix the tab bar\n--"), "patch");
	assert.equal(bumpOf("fix: the tab bar\n--\nfeat: sources of your own\n--"), "minor");
	assert.equal(bumpOf("feat(tui): a conversation list\n--"), "minor");
	assert.equal(bumpOf("feat!: sources take options\n--"), "major");
	assert.equal(bumpOf("Rework the config\n\nBREAKING CHANGE: the old keys are gone\n--"), "major");
	assert.equal(bumpOf("a feature: nothing special\n--\ndefeat: no\n--"), "patch", "only a subject that starts with feat counts");

	// The first release takes the version in package.json.
	assert.deepEqual(nextVersion(undefined, "0.1.0", "patch").version, "0.1.0");
	// Afterwards every push raises it, by what the commits say.
	assert.equal(nextVersion("0.1.0", "0.1.0", "patch").version, "0.1.1");
	assert.equal(nextVersion("0.1.9", "0.1.0", "patch").version, "0.1.10");
	assert.equal(nextVersion("0.1.4", "0.1.0", "minor").version, "0.2.0");
	assert.equal(nextVersion("0.4.2", "0.1.0", "major").version, "0.5.0", "below 1.0.0 a breaking change raises the minor number");
	assert.equal(nextVersion("1.4.2", "0.1.0", "minor").version, "1.5.0");
	assert.equal(nextVersion("1.4.2", "0.1.0", "major").version, "2.0.0");
	// A version set by hand in package.json wins while it is ahead, and no longer once it is reached.
	assert.equal(nextVersion("0.3.7", "1.0.0", "patch").version, "1.0.0");
	assert.equal(nextVersion("1.0.0", "1.0.0", "patch").version, "1.0.1");
	assert.equal(ahead("0.10.0", "0.9.9"), true);
	assert.equal(ahead("1.0.0", "1.0.0"), false);
});
