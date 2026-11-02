import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createPrompt19CandidateDirectory, resolvePrompt19Input} from './prompt19-country-files.mjs';

fs.mkdirSync('.tmp', {recursive: true});
const root = fs.mkdtempSync(path.resolve('.tmp/prompt19-path-fixtures-'));
test('country-scoped reads reject traversal and an in-workspace junction to the other country', () => {
  for (const country of ['KOR', 'PRK']) fs.mkdirSync(path.join(root, `data/raw/prompt19/${country}`), {recursive: true});
  fs.writeFileSync(path.join(root, 'data/raw/prompt19/PRK/raw.json'), '{}');
  fs.symlinkSync(path.join(root, 'data/raw/prompt19/PRK'), path.join(root, 'data/raw/prompt19/KOR/redirect'), 'junction');
  assert.throws(() => resolvePrompt19Input(root, 'data/raw/prompt19/KOR/redirect/raw.json', 'data/raw/prompt19/KOR'), /INPUT_ESCAPED_COUNTRY/);
  assert.throws(() => resolvePrompt19Input(root, '../escape'), /UNSAFE_PATH/);
});
test('a redirected candidate ancestor is rejected before creating a country directory', () => {
  const target = path.join(root, 'redirected-output'); fs.mkdirSync(target);
  fs.mkdirSync(path.join(root, 'data/derived/prompt19'), {recursive: true});
  fs.symlinkSync(target, path.join(root, 'data/derived/prompt19/candidates'), 'junction');
  assert.throws(() => createPrompt19CandidateDirectory(root, 'KOR', 'a'.repeat(20)), /OUTPUT_PARENT_REDIRECTED/);
  assert.deepEqual(fs.readdirSync(target), []);
});
test('new candidate output stays in its named country and an existing candidate is never overwritten', () => {
  const ownRoot = fs.mkdtempSync(path.resolve('.tmp/prompt19-own-output-'));
  const result = createPrompt19CandidateDirectory(ownRoot, 'PRK', 'b'.repeat(20));
  assert.equal(fs.realpathSync(result.output), path.join(ownRoot, 'data/derived/prompt19/candidates/PRK', 'b'.repeat(20)));
  assert.throws(() => createPrompt19CandidateDirectory(ownRoot, 'PRK', 'b'.repeat(20)), /ALREADY_EXISTS/);
  assert.throws(() => createPrompt19CandidateDirectory(ownRoot, 'USA', 'b'.repeat(20)), /OUTPUT_SCOPE/);
});
