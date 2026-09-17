import PostalMime from 'postal-mime';
import { Env } from '../env.js';
import { decompressToXml } from './decompress.js';
import { parseAggregateReport } from './parse.js';
import { storeReport, type StoreResult } from '../db.js';

const REPORT_EXT = /\.(xml|gz|zip)$/i;

function toBytes(content: unknown): Uint8Array {
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === 'string') {
    // postal-mime hands back base64 for binary parts when not configured otherwise.
    const binary = atob(content);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  throw new Error('Unrecognized attachment content type');
}

/**
 * Handle one inbound report email. Returns a result per attachment; a single
 * message occasionally carries more than one report.
 */
export async function handleReportEmail(
  env: Env,
  raw: ReadableStream<Uint8Array>
): Promise<StoreResult[]> {
  const parsed = await PostalMime.parse(raw as unknown as ReadableStream);
  const results: StoreResult[] = [];

  for (const attachment of parsed.attachments ?? []) {
    const filename = attachment.filename ?? '';
    if (!REPORT_EXT.test(filename)) continue;

    const xml = await decompressToXml(toBytes(attachment.content));
    const report = parseAggregateReport(xml);
    results.push(await storeReport(env, report));
  }

  if (results.length === 0) {
    throw new Error(
      `No DMARC report attachment found (subject: ${parsed.subject ?? 'none'}, ` +
        `attachments: ${(parsed.attachments ?? []).length})`
    );
  }

  return results;
}
