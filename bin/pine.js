#!/usr/bin/env node
// pine's launcher. From a checkout it runs the TypeScript sources as they are; from an installed
// package it runs the compiled ones (Node does not run TypeScript from inside node_modules).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (Number(process.versions.node.split(".")[0]) < 24) {
	console.error(`pine needs Node 24 or newer (this is ${process.versions.node}): https://nodejs.org`);
	process.exit(1);
}
// The real place of this file, also when it was started through the link npm puts on the PATH.
const root = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "..");
const source = path.join(root, "src", "cli.ts");
if (fs.existsSync(source)) {
	// A fresh checkout: fetch what pine is built on, once, so that the first command just works.
	if (!fs.existsSync(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent"))) {
		console.error("pine: installing its dependencies (once) ...");
		const done = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: ["ignore", 2, 2] });
		if (done.status !== 0) {
			console.error(`pine: npm install failed; run it in ${root} to see why`);
			process.exit(1);
		}
	}
	await import(pathToFileURL(source).href);
} else await import(pathToFileURL(path.join(root, "src", "cli.js")).href);
