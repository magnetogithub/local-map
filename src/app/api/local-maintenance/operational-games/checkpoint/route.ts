import {checkpointOperationalGames, abortOperationalGameCheckpoint} from '@/lib/simulation/server/operational-game.server';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const url = new URL(request.url), origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || (origin && origin !== url.origin) || site === 'cross-site') return Response.json({error: {code: 'LOCAL_MAINTENANCE_ONLY'}}, {status: 403});
  try {
    const text = await request.text();if (new TextEncoder().encode(text).length > 1024) throw Error('INVALID_CHECKPOINT_REQUEST');
    const body = JSON.parse(text) as {operation?: string; expectedCatalogVersion?: string};
    if (!body || Object.keys(body).some(key => !['operation', 'expectedCatalogVersion'].includes(key)) || typeof body.expectedCatalogVersion !== 'string' || !['checkpoint-all', 'abort-checkpoint'].includes(body.operation ?? '')) throw Error('INVALID_CHECKPOINT_REQUEST');
    const result = body.operation === 'abort-checkpoint' ? abortOperationalGameCheckpoint(body.expectedCatalogVersion) : checkpointOperationalGames(body.expectedCatalogVersion);
    // No private action, event or history content leaves the ignored directory.
    return Response.json(result, {headers: {'Cache-Control': 'no-store'}});
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : 'GAME_CHECKPOINT_WRITE_FAILED';
    return Response.json({error: {code}}, {status: 409, headers: {'Cache-Control': 'no-store'}});
  }
}
