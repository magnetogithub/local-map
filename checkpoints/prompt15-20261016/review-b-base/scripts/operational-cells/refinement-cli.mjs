import fs from 'node:fs';
import path from 'node:path';
import {buildProtectedRefinement} from './common-refinement.mjs';

// Explicit invocation only. Outputs must stay in this candidate's .reports.
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: node scripts/operational-cells/refinement-cli.mjs input.json .reports/output.json');
const reports = path.resolve('.reports');
const output = path.resolve(outputPath);
const relative = path.relative(reports, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output must be a file inside candidate .reports');
fs.mkdirSync(path.dirname(output), {recursive: true});
// Resolve existing parent junctions too; lexical containment alone is insufficient.
const physicalRelative = path.relative(fs.realpathSync(reports), fs.realpathSync(path.dirname(output)));
if (physicalRelative.startsWith('..') || path.isAbsolute(physicalRelative) || fs.existsSync(output)) {
  throw new Error('Output must be a new regular artifact inside candidate .reports');
}
const result = buildProtectedRefinement(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
fs.writeFileSync(output, `${JSON.stringify(result)}\n`, {flag: 'wx'});
process.stdout.write(`${JSON.stringify({kind: result.kind, faces: result.faces.length})}\n`);
