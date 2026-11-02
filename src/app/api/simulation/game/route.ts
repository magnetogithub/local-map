import {operationalGameCommandSchema} from '@/lib/simulation/operational-game-protocol';
import {closeOperationalGame, operationalGameSession, startOperationalGame} from '@/lib/simulation/server/operational-game.server';
import {OPERATIONAL_GAME_HEADER} from '@/lib/simulation/operational-game-protocol';
import {SimulationContractError} from '@/lib/simulation/simulation-contract-primitives';
export const runtime = 'nodejs';
export async function DELETE(request: Request) {
  const id = request.headers.get(OPERATIONAL_GAME_HEADER);
  if (id) closeOperationalGame(id);
  return new Response(null, {status: 204});
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 32 * 1024) return Response.json({error: {code: 'REQUEST_TOO_LARGE'}}, {status: 413});
    const command = operationalGameCommandSchema.parse(JSON.parse(raw));
    const result = command.operation === 'start' ? startOperationalGame() : operationalGameSession(command.sessionId).command(command);
    return Response.json(result, {headers: {'Cache-Control': 'no-store'}});
  } catch (error) {
    const code = error instanceof SimulationContractError ? error.code : error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : 'INVALID_GAME_COMMAND';
    return Response.json({error: {code}}, {status: code === 'INVALID_GAME_COMMAND' ? 400 : 409, headers: {'Cache-Control': 'no-store'}});
  }
}
