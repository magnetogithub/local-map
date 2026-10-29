import path from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error('LEGACY_CLI_UNSUPPORTED: scripts/prompt15-reconcile-stopped-dispatch.mjs');
  console.error('This recovery command targets the retired Prompt 15 controller state and is no longer supported.');
  console.error('For a current v2 run, use: node scripts/prompt15-orchestrator/run.mjs status --run <v2-run>');
  console.error('Source recovery and supported commands: docs/archive/prompt15/legacy-cli/README.md');
  process.exitCode = 1;
}
