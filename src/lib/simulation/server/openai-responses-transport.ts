import {OpenAIResponsesError, readRetryAfterMs} from './openai-responses-error';

export type OpenAIResponsesRequest = Readonly<{
  model: string;
  instructions: string;
  input: readonly unknown[];
  tools: readonly unknown[];
  tool_choice: "required" | Readonly<{type: 'function'; name: 'submit_turn_resolution'}>;
  parallel_tool_calls: false;
  store: false;
  stream: true;
  max_output_tokens: number;
  include: readonly ["reasoning.encrypted_content"];
}>;

export interface OpenAIResponsesTransport {
  stream(request: OpenAIResponsesRequest, signal: AbortSignal): AsyncIterable<unknown>;
}

export class FetchOpenAIResponsesTransport implements OpenAIResponsesTransport {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async *stream(request: OpenAIResponsesRequest, signal: AbortSignal): AsyncIterable<unknown> {
    const response = await this.fetchImplementation("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json"},
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as {
        error?: {code?: unknown; message?: unknown; param?: unknown; type?: unknown};
      } | null;
      const details = payload?.error;
      const fields = [details?.type, details?.code, details?.param, details?.message]
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      throw new OpenAIResponsesError(`Responses API HTTP ${response.status}${fields.length ? `: ${fields.join(" | ")}` : ""}`,
        typeof details?.code === 'string' ? details.code : response.status === 429 ? 'rate_limit_exceeded' : null,
        readRetryAfterMs(Object.fromEntries(response.headers.entries())));
    }
    if (!response.body) throw new Error("Responses API returned an empty stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const {done, value} = await reader.read();
      buffer += decoder.decode(value, {stream: !done});
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data) as unknown;
      }
      if (done) break;
    }
  }
}
