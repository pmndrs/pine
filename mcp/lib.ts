// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No dependencies.
import readline from "node:readline";

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, unknown>;
	handler(args: Record<string, any>): Promise<string> | string;
}

export function options<T = Record<string, any>>(): T {
	try {
		return JSON.parse(process.env.PINE_MCP_OPTIONS ?? "{}");
	} catch {
		return {} as T;
	}
}

export function serve(info: { name: string; version: string; instructions?: string }, tools: McpTool[]): void {
	const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", async (line) => {
		if (!line.trim()) return;
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
		}
		if (msg.id === undefined) return; // notification
		const reply = (result: unknown) => send({ jsonrpc: "2.0", id: msg.id, result });
		switch (msg.method) {
			case "initialize":
				return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: info.name, version: info.version }, instructions: info.instructions });
			case "ping":
				return reply({});
			case "tools/list":
				return reply({ tools: tools.map(({ handler: _h, ...t }) => t) });
			case "tools/call": {
				const tool = tools.find((t) => t.name === msg.params?.name);
				if (!tool) return reply({ content: [{ type: "text", text: `unknown tool ${msg.params?.name}` }], isError: true });
				try {
					return reply({ content: [{ type: "text", text: await tool.handler(msg.params?.arguments ?? {}) }] });
				} catch (e) {
					return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
				}
			}
			default:
				return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
		}
	});
	rl.on("close", () => process.exit(0));
}
