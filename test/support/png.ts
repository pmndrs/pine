import zlib from "node:zlib";

/** A small png made by hand: left half one colour, right half another, so a drawing of it can be checked. */
export function png(width = 64, height = 40, left: [number, number, number] = [220, 40, 40], right: [number, number, number] = [40, 60, 220]): Buffer {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 4 + 1);
		for (let x = 0; x < width; x++) {
			const [r, g, b] = x < width / 2 ? left : right;
			raw.set([r, g, b, 255], row + 1 + x * 4);
		}
	}
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4);
		return out;
	};
	const head = Buffer.alloc(13);
	head.writeUInt32BE(width, 0);
	head.writeUInt32BE(height, 4);
	head.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
