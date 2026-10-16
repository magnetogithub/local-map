// https://nodejs.org/docs/latest-v24.x/api/test.html#custom-reporters
// Console diagnostics are summarized, not copied into an unbounded report.
export default async function* report(source) {
  let summary, failureCount = 0, diagnosticBytes = 0;
  const failures = [];
  for await (const event of source) {
    const data = event.data;
    if (event.type === 'test:summary' && data.file === undefined) summary = data;
    if (['test:stdout', 'test:stderr', 'test:diagnostic'].includes(event.type)) diagnosticBytes += Buffer.byteLength(String(data.message ?? ''));
    if (event.type === 'test:fail') {
      failureCount++;
      if (failures.length < 40) failures.push({name: String(data.name).slice(0, 512), file: data.file, line: data.line,
        message: String(data.details?.error?.cause?.message ?? data.details?.error?.message ?? 'Test failed').slice(0, 2048)});
    }
  }
  const counts = summary?.counts;
  const pass = summary?.success === true && counts?.tests > 0 && counts.failed === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0 && failureCount === 0;
  yield JSON.stringify({version: 1, pass, counts: counts ?? null, durationMs: summary?.duration_ms ?? null,
    failures, failureCount, failuresOmitted: Math.max(0, failureCount - failures.length), diagnosticBytes,
    complete: summary !== undefined, independentReviewIssued: false}) + '\n';
}
