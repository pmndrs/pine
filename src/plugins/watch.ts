import fs from "node:fs";
import path from "node:path";
import type { PineApi } from "../plugins.ts";
import { resolvePath } from "../util.ts";

/**
 * Watches folders and publishes an event for every new file, once the file has stopped growing.
 * Meant for things that drop files: a camera's FTP upload folder, a scanner, a download folder.
 *
 * options: { watches: [{ name, dir, pattern?, settleMs?, recursive? }] }
 *
 * Out: file/<name>/added   { path, file, size, images? }   (trust: untrusted; images set for jpg/png/webp/gif)
 */
const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

export default function watch(pine: PineApi): void {
	for (const w of (pine.options.watches ?? []) as any[]) {
		if (!w?.name || !w?.dir) throw new Error("watch: each entry needs name and dir");
		const dir = fs.realpathSync(resolvePath(String(w.dir), pine.home));
		const pattern = w.pattern ? new RegExp(w.pattern, "i") : undefined;
		const settleMs = Number(w.settleMs ?? 1500);
		const pending = new Map<string, NodeJS.Timeout>();
		const seen = new Map<string, number>();
		pine.media(dir);

		const check = (file: string, lastSize: number) => {
			pending.delete(file);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(file);
			} catch {
				return;
			}
			if (!stat.isFile() || !fs.realpathSync(file).startsWith(dir + path.sep)) return;
			if (stat.size !== lastSize || stat.size === 0) return void pending.set(file, setTimeout(() => check(file, stat.size), settleMs));
			if (seen.get(file) === stat.mtimeMs) return;
			seen.set(file, stat.mtimeMs);
			if (seen.size > 5000) for (const k of [...seen.keys()].slice(0, 2500)) seen.delete(k);
			const mimeType = TYPES[path.extname(file).toLowerCase()];
			pine.bus.publish(`file/${w.name}/added`, { path: file, file: path.relative(dir, file), size: stat.size, images: mimeType && stat.size < 10 * 1024 * 1024 ? [{ path: file, mimeType }] : undefined });
		};

		const watcher = fs.watch(dir, { recursive: w.recursive !== false }, (_type, name) => {
			if (!name) return;
			const file = path.join(dir, String(name));
			if (pattern && !pattern.test(file)) return;
			if (pending.has(file)) return;
			pending.set(file, setTimeout(() => check(file, -1), 200));
		});
		pine.onStop(() => {
			watcher.close();
			pending.forEach((t) => clearTimeout(t));
		});
		pine.log.info(`watching ${dir} as file/${w.name}/added`);
	}
}
