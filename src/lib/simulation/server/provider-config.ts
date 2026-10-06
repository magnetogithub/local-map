import {SimulationProviderError} from "./simulation-provider";

export type SimulationProviderConfig = Readonly<{
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  maxToolIterations: number;
  maxToolCalls: number;
  debugMode: boolean;
}>;

export function loadSimulationProviderConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SimulationProviderConfig {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim();
  if (!apiKey || !model) {
    throw new SimulationProviderError(
      "AI_NOT_CONFIGURED",
      "Simulation AI is not configured on the server",
    );
  }
  return Object.freeze({
    apiKey,
    model,
    timeoutMs: 120_000,
    maxRetries: 1,
    maxToolIterations: 8,
    maxToolCalls: 12,
    debugMode: environment.NODE_ENV !== 'production' && environment.PAX_SIMULATION_DEBUG_MODE?.trim() === "1",
  });
}
