import {loadOperationalCatalog} from '@/lib/world/operational-catalog.server';

export const runtime = 'nodejs';

/** Descriptor only; /map provides browser asset bootstrap. World cutover is separate. */
export async function GET() {
  try {
    return Response.json(loadOperationalCatalog().descriptor, {headers: {'Cache-Control': 'no-store'}});
  } catch {
    return Response.json({error: 'operational_catalog_not_ready'}, {status: 503, headers: {'Cache-Control': 'no-store'}});
  }
}
