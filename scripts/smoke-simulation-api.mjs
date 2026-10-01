const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim();

if (!apiKey || !model) {
  console.log(JSON.stringify({status: "SKIPPED_NO_API_KEY"}));
  process.exit(0);
}

const startedAt = performance.now();
const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
  body: JSON.stringify({
    model,
    store: false,
    instructions: "Adjudicate the supplied diplomatic attempt without guaranteeing success. Return only the strict smoke tool.",
    input: [{role: "user", content: [{type: "input_text", text: JSON.stringify({scenario: "smoke", period: ["2020-01-01", "2020-02-01"], action: "이웃 국가에 무역 협상을 제안한다"})}]}],
    tools: [{
      type: "function",
      name: "submit_smoke_adjudication",
      description: "Return a non-committing smoke adjudication.",
      strict: true,
      parameters: {type: "object", properties: {outcome: {type: "string", enum: ["succeeded", "partially_succeeded", "failed", "delayed"]}, summary: {type: "string", maxLength: 300}}, required: ["outcome", "summary"], additionalProperties: false},
    }],
    tool_choice: {type: "function", name: "submit_smoke_adjudication"},
  }),
});

if (!response.ok) throw new Error(`SMOKE_HTTP_${response.status}`);
const body = await response.json();
const call = body.output?.find((item) => item.type === "function_call" && item.name === "submit_smoke_adjudication");
let schemaValid = false;
if (call?.arguments) {
  const parsed = JSON.parse(call.arguments);
  schemaValid = ["succeeded", "partially_succeeded", "failed", "delayed"].includes(parsed.outcome)
    && typeof parsed.summary === "string" && parsed.summary.length > 0 && parsed.summary.length <= 300;
}
console.log(JSON.stringify({
  status: response.ok && schemaValid ? "PASS" : "FAIL",
  latencyMs: Math.round(performance.now() - startedAt),
  usage: {inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null},
  responseIdSuffix: typeof body.id === "string" ? body.id.slice(-6) : null,
  schemaValid,
}));
if (!schemaValid) process.exitCode = 1;
