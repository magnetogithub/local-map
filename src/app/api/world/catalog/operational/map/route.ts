import {loadOperationalMapDelivery} from '@/lib/map/operational-delivery.server';

export const runtime = 'nodejs';
export async function GET() {
  try {
    return Response.json(loadOperationalMapDelivery().bootstrap, {headers: {'Cache-Control': 'no-store'}});
  } catch {
    return Response.json({error: 'operational_map_not_ready'}, {status: 503, headers: {'Cache-Control': 'no-store'}});
  }
}
