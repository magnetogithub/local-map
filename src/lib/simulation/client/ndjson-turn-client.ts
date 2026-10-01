import type {HostTurnEvent} from "../server/provider-event-normalizer";

const terminalTypes = new Set(["resolution.ready", "turn.failed", "turn.cancelled"]);

export class TurnStreamProtocolError extends Error {
  constructor(readonly code: "MALFORMED_EVENT" | "OUT_OF_ORDER" | "DISCONNECTED", message: string) {
    super(message);
    this.name = "TurnStreamProtocolError";
  }
}

export class NdjsonHostEventParser {
  private buffer = "";
  private nextSequence = 0;
  private terminal = false;

  push(chunk: string): readonly HostTurnEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim()).map((line) => this.parseLine(line));
  }

  finish(): readonly HostTurnEvent[] {
    const tail = this.buffer.trim();
    this.buffer = "";
    const events = tail ? [this.parseLine(tail)] : [];
    if (!this.terminal) throw new TurnStreamProtocolError("DISCONNECTED", "Turn stream ended before a terminal event");
    return events;
  }

  private parseLine(line: string): HostTurnEvent {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { throw new TurnStreamProtocolError("MALFORMED_EVENT", "Turn stream contains invalid JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TurnStreamProtocolError("MALFORMED_EVENT", "Turn event must be an object");
    const event = value as Record<string, unknown>;
    if (event.version !== 1 || typeof event.turnId !== "string" || typeof event.type !== "string" || event.sequence !== this.nextSequence) {
      throw new TurnStreamProtocolError(event.sequence !== this.nextSequence ? "OUT_OF_ORDER" : "MALFORMED_EVENT", "Turn event envelope is invalid");
    }
    if (this.terminal) throw new TurnStreamProtocolError("OUT_OF_ORDER", "Event arrived after terminal event");
    this.nextSequence += 1;
    if (terminalTypes.has(event.type)) this.terminal = true;
    return value as HostTurnEvent;
  }
}

export async function streamSimulationTurn(
  request: unknown,
  signal: AbortSignal,
  onEvent: (event: HostTurnEvent) => void,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImplementation("/api/simulation/turn", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as {error?: {code?: string; message?: string}} | null;
    throw new Error(body?.error?.code ?? `HTTP_${response.status}`);
  }
  if (!response.body) throw new TurnStreamProtocolError("DISCONNECTED", "Turn stream has no body");
  const parser = new NdjsonHostEventParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, {stream: true})).forEach(onEvent);
  }
  parser.push(decoder.decode()).forEach(onEvent);
  parser.finish().forEach(onEvent);
}
