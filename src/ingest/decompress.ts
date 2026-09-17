/**
 * DMARC aggregate reports arrive as .xml.gz (most reporters) or .zip (Microsoft,
 * some others), occasionally bare .xml. Workers give us DecompressionStream for
 * gzip and deflate-raw, so the only thing we hand-roll is enough of the ZIP local
 * file header to find where the deflate stream starts.
 */

async function inflate(data: Uint8Array, format: 'gzip' | 'deflate-raw'): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const decompressed = source.pipeThrough(new DecompressionStream(format));
  const buf = await new Response(decompressed).arrayBuffer();
  return new Uint8Array(buf);
}

function isGzip(d: Uint8Array): boolean {
  return d.length > 2 && d[0] === 0x1f && d[1] === 0x8b;
}

function isZip(d: Uint8Array): boolean {
  return d.length > 4 && d[0] === 0x50 && d[1] === 0x4b && d[2] === 0x03 && d[3] === 0x04;
}

/**
 * Read the first entry of a ZIP. Aggregate reports are always single-entry, so
 * walking the central directory would be wasted work.
 */
async function unzipFirstEntry(d: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const method = view.getUint16(8, true);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const start = 30 + nameLen + extraLen;

  if (method === 0) {
    // Stored. compressed size is authoritative here; streaming-mode zips (bit 3)
    // put 0 in the header, in which case fall back to everything that follows.
    const size = view.getUint32(18, true);
    return size > 0 ? d.slice(start, start + size) : d.slice(start);
  }
  if (method !== 8) {
    throw new Error(`Unsupported ZIP compression method: ${method}`);
  }
  return inflate(d.slice(start), 'deflate-raw');
}

/** Returns the XML text of an attachment regardless of how it was packed. */
export async function decompressToXml(data: Uint8Array): Promise<string> {
  let raw = data;
  if (isGzip(data)) {
    raw = await inflate(data, 'gzip');
  } else if (isZip(data)) {
    raw = await unzipFirstEntry(data);
  }
  return new TextDecoder().decode(raw);
}
