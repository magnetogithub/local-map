export class OpenAIResponsesError extends Error {
  constructor(message: string, readonly code: string | null = null, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = 'OpenAIResponsesError';
  }
}

export function readRetryAfterMs(headers: Readonly<Record<string, unknown>> | null): number | null {
  const milliseconds = headers?.['retry-after-ms'];
  const seconds = headers?.['retry-after'];
  const value = milliseconds ?? seconds;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value) * (milliseconds === undefined ? 1000 : 1);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
