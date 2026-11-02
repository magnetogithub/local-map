import {createProductionSimulationProvider} from "@/lib/simulation/server/production-provider.server";
import {createSimulationTurnPost} from "@/lib/simulation/server/simulation-turn-handler";
import {operationalGameSession} from '@/lib/simulation/server/operational-game.server';
import {OPERATIONAL_GAME_HEADER} from '@/lib/simulation/operational-game-protocol';

export const runtime = "nodejs";
const legacyPost = createSimulationTurnPost({createProvider: createProductionSimulationProvider});
export async function POST(request: Request) {
  const id = request.headers.get(OPERATIONAL_GAME_HEADER);
  if (!id) return legacyPost(request);
  try {
    const session = operationalGameSession(id);
    return createSimulationTurnPost({createProvider: () => session.provider(createProductionSimulationProvider()), resolveOperationalWorld: session.resolveRequest})(request);
  } catch {
    return Response.json({error: {code: 'GAME_SESSION_EXPIRED', message: '새 게임으로 다시 시작하세요.'}}, {status: 409});
  }
}
