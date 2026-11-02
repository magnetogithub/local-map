import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {loadOperationalCatalog} from '@/lib/world/operational-catalog.server';
export const runtime = 'nodejs';
let bytes: Promise<Buffer> | undefined;

/** Mutable state is delivered separately. This is only the immutable ordinal -> ID array. */
export async function GET() {
  try {
    const catalog = loadOperationalCatalog();
    bytes ??= promisify(gzip)(JSON.stringify({catalogRef: catalog.ref, cellIds: catalog.worldContract().territoryOrder})).catch(error => {bytes = undefined; throw error;});
    return new Response(new Uint8Array(await bytes), {headers: {'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store'}});
  } catch {return Response.json({error: 'catalog_not_ready'}, {status: 503});}
}
