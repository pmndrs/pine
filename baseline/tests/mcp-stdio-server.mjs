// Minimal MCP server over stdio (newline-delimited JSON-RPC). No dependencies.
import fs from "node:fs";
import readline from "node:readline";
const startDelay = Number(process.env.MCP_START_DELAY_MS ?? 0);
const label = process.env.MCP_LABEL ?? "test";
if (process.env.MCP_PID_FILE) fs.appendFileSync(process.env.MCP_PID_FILE, `${process.pid}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const tools = [
	{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
	{ name: "whoami", description: "Report server process identity", inputSchema: { type: "object", properties: {} } },
	{ name: "crash", description: "Kill the server process", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
	{ name: "big", description: "Return a large text", inputSchema: { type: "object", properties: {} } },
];
const rl = readline.createInterface({ input: process.stdin });
const ready = new Promise((r) => setTimeout(r, startDelay));
rl.on("line", async (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	await ready;
	if (msg.id === undefined) return; // notification
	const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
	switch (msg.method) {
		case "initialize":
			return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `mock-${label}`, version: "1.0.0" }, instructions: `Mock MCP server ${label} for baseline tests.` });
		case "ping":
			return reply({});
		case "tools/list":
			return reply({ tools });
		case "tools/call": {
			const { name, arguments: args } = msg.params;
			if (name === "echo") return reply({ content: [{ type: "text", text: `echo(${label}): ${args?.text}` }] });
			if (name === "whoami") return reply({ content: [{ type: "text", text: JSON.stringify({ label, pid: process.pid, cwd: process.cwd(), secret: process.env.MCP_SECRET ?? null }) }] });
			if (name === "big") return reply({ content: [{ type: "text", text: "B".repeat(60000) }] });
			if (name === "crash") process.exit(7);
			return reply({ content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
		}
		default:
			return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
	}
});
rl.on("close", () => process.exit(0));
