import {parseSimulationContextV1} from "@/lib/simulation/simulation-context";
import {assertSafeSimulationData, simulationIdSchema} from "@/lib/simulation/simulation-contract-primitives";
import {z} from "zod";
import {createProductionSimulationProvider} from '@/lib/simulation/server/production-provider.server';
import {normalizeProviderEvents} from "@/lib/simulation/server/provider-event-normalizer";
import {
  SimulationProviderError,
  type SimulationModelProvider,
  type SimulationProviderRequest,
} from "@/lib/simulation/server/simulation-provider";

export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 256 * 1024;

type RouteDependencies = Readonly<{
  createProvider(): SimulationModelProvider;
}>;

const simulationTurnRequestSchema = z.strictObject({
  turnId: simulationIdSchema,
  context: z.unknown(),
});

function parseRequestBody(raw: string): SimulationProviderRequest {
  const parsed: unknown = JSON.parse(raw);
  assertSafeSimulationData(parsed);
  const envelope = simulationTurnRequestSchema.parse(parsed);
  return {turnId: envelope.turnId, context: parseSimulationContextV1(envelope.context)};
}

const jsonError = (status: number, code: string, message: string) =>
  Response.json({error: {code, message}}, {status});

export function createSimulationTurnPost(dependencies: RouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return jsonError(413, "REQUEST_TOO_LARGE", "Request body is too large");
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return jsonError(400, "MALFORMED_REQUEST", "Unable to read request body");
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) return jsonError(413, "REQUEST_TOO_LARGE", "Request body is too large");
    let providerRequest: SimulationProviderRequest;
    try {
      providerRequest = parseRequestBody(raw);
    } catch {
      return jsonError(400, "MALFORMED_REQUEST", "Request body does not match the simulation turn contract");
    }
    let provider: SimulationModelProvider;
    try {
      provider = dependencies.createProvider();
    } catch (error) {
      if (error instanceof SimulationProviderError && error.code === "AI_NOT_CONFIGURED") return jsonError(503, error.code, error.message);
      return jsonError(502, "PROVIDER_ERROR", "Unable to initialize simulation provider");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", onAbort, {once: true});
    const encoder = new TextEncoder();
    const iterator = normalizeProviderEvents(
      providerRequest.turnId,
      provider.streamTurn(providerRequest, controller.signal),
    )[Symbol.asyncIterator]();
    const stream = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const item = await iterator.next();
          if (item.done) {
            request.signal.removeEventListener("abort", onAbort);
            streamController.close();
            return;
          }
          streamController.enqueue(encoder.encode(`${JSON.stringify(item.value)}\n`));
        } catch {
          streamController.enqueue(encoder.encode(`${JSON.stringify({version: 1, turnId: providerRequest.turnId, sequence: Number.MAX_SAFE_INTEGER, type: "turn.failed", code: "PROVIDER_ERROR", message: "Provider stream failed", retryable: true})}\n`));
          streamController.close();
        }
      },
      async cancel(reason) {
        controller.abort(reason);
        request.signal.removeEventListener("abort", onAbort);
        await iterator.return?.(undefined as never);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}

export const POST = createSimulationTurnPost({createProvider:createProductionSimulationProvider});
