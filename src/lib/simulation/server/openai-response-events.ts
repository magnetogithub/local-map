export type CompletedToolCall = Readonly<{callId: string; name: string; argumentsText: string}>;
export type NormalizedOpenAIEvent =
  | Readonly<{type: "draft.delta"; delta: string}>
  | Readonly<{type: "tool.started"; callId: string; name: string}>
  | Readonly<{type: "tool.ready"; call: CompletedToolCall}>
  | Readonly<{type: "refusal"}>
  | Readonly<{type: "failed"; message: string}>
  | Readonly<{type: "response.item"; item: Readonly<Record<string, unknown>>}>
  | Readonly<{type: "completed"; responseId: string}>;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

export class OpenAIResponseEventAccumulator {
  private readonly calls = new Map<string, {callId: string; name: string; argumentsText: string; ready: boolean}>();

  private findCall(event: Record<string, unknown>) {
    for (const key of [event.call_id, event.item_id, typeof event.output_index === "number" ? `index:${event.output_index}` : null]) {
      if (typeof key === "string" && this.calls.has(key)) return this.calls.get(key) ?? null;
    }
    return null;
  }

  private complete(call: {callId: string; name: string; argumentsText: string; ready: boolean}, argumentsText?: unknown): readonly NormalizedOpenAIEvent[] {
    if (call.ready) return [];
    call.ready = true;
    if (typeof argumentsText === "string") call.argumentsText = argumentsText;
    return [{type: "tool.ready", call: Object.freeze({callId: call.callId, name: call.name, argumentsText: call.argumentsText})}];
  }

  accept(raw: unknown): readonly NormalizedOpenAIEvent[] {
    const event = record(raw);
    const type = typeof event?.type === "string" ? event.type : "";
    if (type === "response.output_text.delta" && typeof event?.delta === "string") return [{type: "draft.delta", delta: event.delta}];
    if (type === "response.refusal.delta" || type === "response.refusal.done") return [{type: "refusal"}];
    if (type === "error" || type === "response.failed" || type === "response.incomplete") return [{type: "failed", message: "Responses API did not complete"}];
    if (type === "response.output_item.added") {
      const item = record(event?.item);
      if (item?.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
        const call = {callId: item.call_id, name: item.name, argumentsText: typeof item.arguments === "string" ? item.arguments : "", ready: false};
        this.calls.set(item.call_id, call);
        if (typeof item.id === "string") this.calls.set(item.id, call);
        if (typeof event?.output_index === "number") this.calls.set(`index:${event.output_index}`, call);
        return [{type: "tool.started", callId: item.call_id, name: item.name}];
      }
    }
    if (type === "response.function_call_arguments.delta" && typeof event?.delta === "string") {
      const call = event ? this.findCall(event) : null;
      if (call) call.argumentsText += event.delta;
    }
    if (type === "response.function_call_arguments.done" && event) {
      const call = this.findCall(event);
      if (call) return this.complete(call, event.arguments);
    }
    if (type === "response.output_item.done") {
      const item = record(event?.item);
      if (!item) return [];
      const normalized: NormalizedOpenAIEvent[] = [{type: "response.item", item}];
      if (item?.type === "function_call") {
        const call = typeof item.call_id === "string" ? this.calls.get(item.call_id) : null;
        if (call) normalized.unshift(...this.complete(call, item.arguments));
      }
      return normalized;
    }
    if (type === "response.completed") {
      const response = record(event?.response);
      return [{type: "completed", responseId: typeof response?.id === "string" ? response.id : ""}];
    }
    return [];
  }
}
