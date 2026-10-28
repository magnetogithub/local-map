import {loadOperationalMapDelivery} from '@/lib/map/operational-delivery.server';

export const runtime = 'nodejs';
export async function GET(request: Request, context: {params: Promise<{version: string; asset: string[]}>}) {
  try {
    const {version, asset} = await context.params;
    const result = loadOperationalMapDelivery().asset(version, asset.join('/'));
    if (!result) return new Response(null, {status: 404});
    const etag = `"${result.identity.sha256}"`;
    const headers = {'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag,
      'Content-Type': asset.at(-1)!.endsWith('.gz') ? 'application/gzip' : 'application/json',
      'X-Content-Type-Options': 'nosniff'};
    if (request.headers.get('if-none-match') === etag) return new Response(null, {status: 304, headers});
    // These are gzip *payload* bytes. HTTP Content-Encoding would destroy their hash identity.
    return new Response(new Uint8Array(result.bytes), {headers: {...headers, 'Content-Length': String(result.bytes.length)}});
  } catch {
    return Response.json({error: 'operational_asset_unavailable'}, {status: 503, headers: {'Cache-Control': 'no-store'}});
  }
}
