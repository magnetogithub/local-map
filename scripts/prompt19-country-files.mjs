import fs from 'node:fs';
import path from 'node:path';

const safeRelative = file => typeof file === 'string' && /^[A-Za-z0-9._/-]+$/.test(file) && !file.split('/').some(p => !p || p === '.' || p === '..');
const inside = (base, target) => {const relative = path.relative(base, target); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));};
export function resolvePrompt19Input(root, file, scope) {
  if (!safeRelative(file) || (scope && !safeRelative(scope))) throw Error('PROMPT19_UNSAFE_PATH');
  const physicalRoot = fs.realpathSync(root), target = fs.realpathSync(path.resolve(physicalRoot, file));
  if (!inside(physicalRoot, target)) throw Error('PROMPT19_INPUT_ESCAPED_WORKSPACE');
  if (scope) {
    const expectedScope = path.resolve(physicalRoot, scope), physicalScope = fs.realpathSync(expectedScope);
    if (physicalScope !== expectedScope || !inside(physicalScope, target)) throw Error('PROMPT19_INPUT_ESCAPED_COUNTRY');
  }
  return target;
}

/** Check the nearest existing ancestor before any mkdir; then create and verify one level at a time. */
export function createPrompt19CandidateDirectory(root, countryId, key) {
  if (!['KOR', 'PRK'].includes(countryId) || !/^[a-f0-9]{20}$/.test(key)) throw Error('PROMPT19_OUTPUT_SCOPE');
  const physicalRoot = fs.realpathSync(root), relative = `data/derived/prompt19/candidates/${countryId}/${key}`;
  const output = path.resolve(physicalRoot, relative);
  if (fs.existsSync(output)) throw Error('PROMPT19_CANDIDATE_ALREADY_EXISTS');
  let ancestor = path.dirname(output);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!inside(physicalRoot, ancestor) || fs.realpathSync(ancestor) !== ancestor || !fs.statSync(ancestor).isDirectory()) throw Error('PROMPT19_OUTPUT_PARENT_REDIRECTED');
  let current = ancestor;
  for (const part of path.relative(ancestor, output).split(path.sep)) {
    if (fs.realpathSync(current) !== current) throw Error('PROMPT19_OUTPUT_PARENT_REDIRECTED');
    current = path.join(current, part); fs.mkdirSync(current);
    if (fs.realpathSync(current) !== current) throw Error('PROMPT19_OUTPUT_PARENT_REDIRECTED');
  }
  return {relative, output};
}
