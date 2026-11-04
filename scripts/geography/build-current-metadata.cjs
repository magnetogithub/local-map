// Offline CLI only. Existing application TS modules use extensionless imports;
// transpile them with the installed, lock-pinned TypeScript in this process.
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true},
  fileName: file,
}).outputText, file);

try {
  const args = process.argv.slice(2);
  if (!args.length) {
    const {buildCurrentGeographyMetadata} = require('./metadata-builder.ts');
    process.stdout.write(JSON.stringify(buildCurrentGeographyMetadata(), null, 2) + '\n');
  } else if (args.length === 2 && args[0] === '--verify') {
    const {verifyCurrentGeographyOutput} = require('./verify-metadata.ts');
    process.stdout.write(JSON.stringify(verifyCurrentGeographyOutput(process.cwd(), args[1]), null, 2) + '\n');
  } else throw Error('Usage: node scripts/geography/build-current-metadata.cjs [--verify <repository-relative-manifest.json>]');
} catch (error) {
  const detail = error && Array.isArray(error.issues)
    ? JSON.stringify({code: 'GEOGRAPHY_SCHEMA', issues: error.issues.slice(0, 5), totalIssues: error.issues.length})
    : error instanceof Error ? error.stack : String(error);
  process.stderr.write(detail + '\n');
  process.exitCode = 1;
}
