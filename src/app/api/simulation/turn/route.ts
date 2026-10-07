import {createProductionSimulationProvider} from "@/lib/simulation/server/production-provider.server";
import {createSimulationTurnPost} from "@/lib/simulation/server/simulation-turn-handler";

export const runtime = "nodejs";
export const POST = createSimulationTurnPost({createProvider: createProductionSimulationProvider});
