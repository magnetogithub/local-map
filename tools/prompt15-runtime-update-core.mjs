import path from 'node:path';
import {inside} from '../scripts/prompt15-orchestrator/protocol.mjs';

// Turn responses live at the round root, including scoped task verification.
export function taskResponsePath(root, run, event) {
  const rounds = path.join(run, 'rounds');
  const reported = path.resolve(root, event.reportDirectory);
  if (!inside(rounds, reported) || reported === rounds) throw Error('Task report escapes this run');
  const round = path.relative(rounds, reported).split(path.sep)[0];
  const response = path.join(rounds, round, `${event.responseKey ?? event.key}-response.json`);
  if (!inside(path.join(rounds, round), response)) throw Error('Task response escapes its round');
  return response;
}
