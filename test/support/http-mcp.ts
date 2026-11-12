import http from "node:http";

/**
 * A minimal remote (streamable HTTP) MCP server with one tool, `lookup`. With `token`, it answers
 * 401 without it; with `filesNeedToken` its files want it too. With `picture`, every answer of a
 * tool comes with that picture. With `readOnly`, it has a second tool, `peek`, that declares itself read-only.
 */
export async function httpMcp(opts: { token?: string; readOnly?: boolean; delayMs?: number; files?: Record<string, Buffer>; redirects?: Record<string, string>; filesNeedToken?: boolean; picture?: Buffer } = {}) {
	const calls: Array<{ method: string; auth?: string }> = [];
	/** What was asked for under /files, and with which key. */
	const gets: Array<{ name: string; auth?: string }> = [];
	const server = http.createServer(async (req, res) => {
		// Download links, as a server that hands out files would serve them.
		const name = decodeURIComponent((req.url ?? "").replace(/^\/files\//, ""));
		const file = req.method === "GET" && (req.url ?? "").startsWith("/files/");
		if (file) gets.push({ name, auth: req.headers.authorization });
		if (file && opts.filesNeedToken && req.headers.authorization !== `Bearer ${opts.token}`) return void res.writeHead(401, { "www-authenticate": "Bearer" }).end();
		if (req.method === "GET" && opts.redirects?.[name]) return void res.writeHead(302, { location: opts.redirects[name] }).end();
		if (req.method === "GET" && opts.files?.[name]) return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(opts.files[name]);
		if (req.method !== "POST") return void res.writeHead(req.method === "GET" ? 404 : 405).end();
		let raw = "";
		for await (const c of req) raw += c;
		const msg = JSON.parse(raw);
		calls.push({ method: msg.method, auth: req.headers.authorization });
		if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return void res.writeHead(401, { "www-authenticate": "Bearer" }).end();
		if (msg.id === undefined) return void res.writeHead(202).end();
		const result =
			msg.method === "initialize"
				? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http-stub", version: "1" } }
				: msg.method === "tools/list"
					? { tools: [{ name: "lookup", description: "Look something up", inputSchema: { type: "object", properties: { q: { type: "string" } } } }, ...(opts.readOnly ? [{ name: "peek", description: "Read something", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { q: { type: "string" } } } }] : [])] }
					: msg.method === "tools/call"
						? { content: [{ type: "text", text: `${msg.params.name === "peek" ? "peeked" : "looked up"}: ${msg.params.arguments?.q}` }, ...(opts.picture ? [{ type: "image", data: opts.picture.toString("base64"), mimeType: "image/png" }] : [])] }
						: {};
		if (opts.delayMs && msg.method === "tools/call") await new Promise((r) => setTimeout(r, opts.delayMs));
		if (res.destroyed) return;
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
		calls,
		gets,
		close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
	};
}
