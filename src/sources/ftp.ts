import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { timingSafeEqual } from "../security.ts";
import { Type } from "typebox";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText } from "../util.ts";

/**
 * An FTP drop: a small FTP server that accepts uploads and nothing else. For cameras, doorbells,
 * scanners and other devices whose only way of sending a file is "upload to FTP server".
 *
 * options: { port, user, password, host?, allow?, pasvPorts?, maxFileMb?, keepDays? }
 *   port, user, password  what you enter in the device. The password must have 8 characters or more.
 *   host       address to listen on. Default "0.0.0.0": devices on your network have to reach it.
 *   allow      only these client addresses, as prefixes: ["192.168.1.40", "192.168.2."]
 *   pasvPorts  [from, to]: ports for the data connections, if a firewall needs to know them
 *   maxFileMb  largest file accepted (default 50)
 *   keepDays   received files are deleted after this many days (default 7)
 *
 * event "upload": { file, path, size, from, images? }   file is the name the device gave it
 *
 * It speaks plain FTP, as these devices do: the password crosses your network unencrypted. It can
 * only receive. Nothing can be listed, read, changed or deleted through it, and every file lands
 * under a name of pine's choosing inside the source's own folder.
 */
const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

export const type: SourceType = {
	summary: "an FTP drop: a small server that accepts uploads and nothing else. For cameras, doorbells and scanners whose only way of sending a file is \"upload to FTP server\"",
	options: Type.Object(
		{
			port: Type.Number({ description: "port to listen on, e.g. 2121" }),
			user: Type.Optional(Type.String({ description: 'user name the device logs in with. Default "device"' })),
			password: Type.Optional(Type.String({ description: "password the device logs in with, 8 characters or more. Leave it out and pine makes one", secret: true })),
			host: Type.Optional(Type.String({ description: 'address to listen on. Default "0.0.0.0", so that devices on the network reach it' })),
			allow: Type.Optional(Type.Array(Type.String(), { description: 'only these client addresses, as prefixes: ["192.168.1.40", "192.168.2."]' })),
			pasvPorts: Type.Optional(Type.Array(Type.Number(), { description: "[from, to]: ports for the data connections, if a firewall needs to know them" })),
			maxFileMb: Type.Optional(Type.Number({ description: "largest file accepted, in MB. Default 50" })),
			keepDays: Type.Optional(Type.Number({ description: "received files are deleted after this many days. Default 7" })),
		},
		{ additionalProperties: false },
	),
	plan(o, setup) {
		if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error(`"port" must be a port number, for example 2121`);
		if (o.password !== undefined && String(o.password).length < 8) throw new Error("the password must have 8 characters or more");
		if (o.pasvPorts && o.pasvPorts.length !== 2) throw new Error(`"pasvPorts" is two numbers: [from, to]`);
		const user = o.user ?? "device";
		return {
			options: { ...o, user, password: o.password ?? setup.random(9) },
			does: [`open an upload-only FTP server on port ${o.port} of this computer for the user "${user}"${o.password ? "" : " with a password made now"}${o.allow?.length ? `, for the addresses ${o.allow.join(", ")}` : ""}`],
			opens: true,
			tell: `The device uploads to port ${o.port} as user "${user}". The password is in pine's .env file as ${setup.envName("password")}, where your owner reads it.`,
		};
	},
};

export default async function ftp(source: SourceApi): Promise<void> {
	const o = source.options;
	const port = Number(o.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`needs "port" (for example 2121)`);
	const user = String(o.user ?? "");
	const password = String(o.password ?? "");
	if (!user || password.length < 8) throw new Error(`needs "user" and a "password" of 8 characters or more: without them anyone on the network could hand files to your agents`);
	source.secret(password);
	const host = String(o.host ?? "0.0.0.0");
	const allow: string[] = (Array.isArray(o.allow) ? o.allow : []).map(String);
	const range: [number, number] | undefined = Array.isArray(o.pasvPorts) && o.pasvPorts.length === 2 ? [Number(o.pasvPorts[0]), Number(o.pasvPorts[1])] : undefined;
	const maxBytes = Number(o.maxFileMb ?? 50) * 1024 * 1024;
	const keepMs = Number(o.keepDays ?? 7) * 86_400_000;
	const dir = path.join(source.dataDir, "files");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	source.media(dir);

	const prune = () => {
		for (const name of fs.readdirSync(dir)) {
			const file = path.join(dir, name);
			try {
				if (Date.now() - fs.statSync(file).mtimeMs > keepMs) fs.rmSync(file, { force: true });
			} catch {
				// gone already
			}
		}
	};
	prune();
	const pruner = setInterval(prune, 6 * 3_600_000);
	pruner.unref?.();

	const plain = (addr: string | undefined) => (addr ?? "").replace(/^::ffff:/, "");
	const open = new Set<net.Socket>();
	let counter = 0;

	const server = net.createServer((control) => {
		const remote = plain(control.remoteAddress);
		if (open.size >= 20 || (allow.length && !allow.some((a) => remote === a || (a.endsWith(".") && remote.startsWith(a))))) return void control.destroy();
		open.add(control);
		control.setTimeout(120_000, () => control.destroy());
		control.setEncoding("utf8");
		let name = "";
		let authed = false;
		let failures = 0;
		let cwd = "/";
		let passive: net.Server | undefined;
		let data: Promise<net.Socket> | undefined;
		const say = (line: string) => control.writable && control.write(`${line}\r\n`);
		const closePassive = () => {
			passive?.close();
			passive = undefined;
			data?.then((s) => s.destroy()).catch(() => {});
			data = undefined;
		};
		control.on("close", () => {
			open.delete(control);
			closePassive();
		});
		control.on("error", () => {});

		/** Open a port for the next transfer. Only the device on the control connection may connect to it. */
		const listen = async (): Promise<number> => {
			closePassive();
			const s = net.createServer();
			passive = s;
			data = new Promise<net.Socket>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("no data connection")), 20_000);
				s.on("connection", (sock) => {
					if (plain(sock.remoteAddress) !== remote) return void sock.destroy();
					clearTimeout(timer);
					s.close();
					resolve(sock);
				});
				s.on("close", () => clearTimeout(timer));
			});
			data.catch(() => {});
			const tryPort = (p: number) =>
				new Promise<number>((resolve, reject) => {
					s.once("error", reject);
					s.listen(p, host === "0.0.0.0" ? plain(control.localAddress) : host, () => (s.removeListener("error", reject), resolve((s.address() as net.AddressInfo).port)));
				});
			if (!range) return tryPort(0);
			for (let p = range[0]; p <= range[1]; p++) {
				try {
					return await tryPort(p);
				} catch {
					// taken; try the next one
				}
			}
			throw new Error("no free data port");
		};

		const receive = async (given: string) => {
			if (!data) return say("425 Use PASV first");
			const wanted = path.posix.join(cwd, given);
			const clean = path.basename(given).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(-80) || "file";
			const target = path.join(dir, `${Date.now().toString(36)}${(counter++).toString(36)}-${clean}`);
			say("150 Send it");
			let sock: net.Socket;
			try {
				sock = await data;
			} catch {
				return say("425 No data connection");
			}
			data = undefined;
			let size = 0;
			let tooBig = false;
			// "wx": the name is new; nothing that exists is ever written over.
			const out = fs.createWriteStream(target, { flags: "wx", mode: 0o600 });
			sock.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBytes) {
					tooBig = true;
					sock.destroy();
				}
			});
			sock.pipe(out);
			await new Promise<void>((resolve) => {
				out.on("close", resolve);
				out.on("error", () => resolve());
				// A connection that is cut (by the device, or here because the file got too large) never
				// says "end"; the file is closed all the same, so the transfer gets its answer.
				sock.on("close", () => out.end());
				sock.on("error", () => out.end());
			});
			if (tooBig || size === 0) {
				fs.rmSync(target, { force: true });
				return say(tooBig ? "552 File too large" : "451 Nothing received");
			}
			say("226 Stored");
			const mimeType = TYPES[path.extname(clean).toLowerCase()];
			try {
				source.emit("upload", { file: wanted, path: target, size, from: remote, images: mimeType && size < 10 * 1024 * 1024 ? [{ path: target, mimeType }] : undefined });
			} catch (e) {
				source.log.warn("could not report an upload", errText(e));
			}
		};

		const handle = async (line: string) => {
			const [verb, ...rest] = line.trim().split(" ");
			const arg = rest.join(" ");
			const cmd = verb.toUpperCase();
			if (cmd === "QUIT") return void (say("221 Bye"), control.end());
			if (cmd === "USER") return void ((name = arg), say("331 Password"));
			if (cmd === "PASS") {
				authed = timingSafeEqual(name, user) && timingSafeEqual(arg, password);
				if (authed) return say("230 Welcome");
				if (++failures >= 3) return void (say("530 Bye"), control.end());
				return say("530 Login incorrect");
			}
			if (cmd === "SYST") return say("215 UNIX Type: L8");
			if (cmd === "FEAT") return say("211-Features:\r\n PASV\r\n EPSV\r\n UTF8\r\n211 End");
			if (!authed) return say("530 Log in first");
			switch (cmd) {
				case "OPTS":
				case "TYPE":
				case "MODE":
				case "STRU":
				case "NOOP":
				case "ALLO":
					return say("200 OK");
				case "PWD":
				case "XPWD":
					return say(`257 "${cwd}"`);
				case "CWD":
				case "XCWD":
					cwd = path.posix.resolve(cwd, arg || "/");
					return say("250 OK");
				case "CDUP":
					cwd = path.posix.resolve(cwd, "..");
					return say("250 OK");
				// Folders exist only as part of the name a file is reported under.
				case "MKD":
				case "XMKD":
					return say(`257 "${path.posix.resolve(cwd, arg)}"`);
				case "PASV": {
					const p = await listen();
					const ip = plain(control.localAddress).split(".");
					if (ip.length !== 4) return say("425 Use EPSV");
					return say(`227 Entering Passive Mode (${ip.join(",")},${p >> 8},${p & 255})`);
				}
				case "EPSV":
					return say(`229 Entering Extended Passive Mode (|||${await listen()}|)`);
				case "STOR":
				case "APPE":
				case "STOU":
					return receive(arg || "file");
				case "LIST":
				case "NLST":
				case "MLSD": {
					// Always empty: this server gives nothing back.
					if (!data) return say("425 Use PASV first");
					say("150 Here it comes");
					const sock = await data.catch(() => undefined);
					data = undefined;
					sock?.end();
					return say("226 Done");
				}
				// Some devices upload under a temporary name and rename afterwards. The file is already reported; say yes.
				case "RNFR":
					return say("350 Ready");
				case "RNTO":
				case "DELE":
				case "RMD":
				case "SITE":
					return say("250 OK");
				case "SIZE":
				case "MDTM":
				case "RETR":
					return say("550 Not available");
				default:
					return say("502 Not implemented");
			}
		};

		let buffer = "";
		let busy: Promise<unknown> = Promise.resolve();
		control.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > 8192) return void control.destroy();
			let i: number;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, i).replace(/\r$/, "");
				buffer = buffer.slice(i + 1);
				busy = busy.then(() => handle(line)).catch((e) => (source.log.debug("ftp command failed", errText(e)), say("451 Failed")));
			}
		});
		say("220 pine file drop");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => (server.removeListener("error", reject), resolve()));
	});
	source.onStop(
		() =>
			new Promise<void>((resolve) => {
				clearInterval(pruner);
				for (const s of open) s.destroy();
				server.close(() => resolve());
			}),
	);
	source.log.info(`accepting uploads on ${host}:${port}`);
}
