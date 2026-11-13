#!/usr/bin/env node
// pine has moved from @pmndrs/pine to @pmndre/pine. This package only forwards to it: it depends
// on @pmndre/pine and starts its launcher, so "pine" keeps working where the old name is installed.

// "pine update" would ask npm for a newer @pmndre/pine and install it globally, which npm refuses
// while this package owns the "pine" command. So an update says how to switch over instead.
if (process.argv[2] === "update") {
	console.error(
		[
			"pine has moved from @pmndrs/pine to @pmndre/pine.",
			"This install forwards to the new package but cannot update it. Switch over once:",
			"",
			"  npm uninstall -g @pmndrs/pine && npm install -g @pmndre/pine",
			"",
			"After that, pine update works as before.",
		].join("\n"),
	);
	process.exit(process.argv.includes("--check") ? 0 : 1);
}

await import("@pmndre/pine/bin/pine.js");
