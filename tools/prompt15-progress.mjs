import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'reports/prompt15/orchestrator-v2');
const kst = value => value ? new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}).format(new Date(value)) + ' KST' : '-';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const brief = (value, limit = 320) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};

function latestDirectory() {
  const latest = path.join(base, 'latest.json');
  if (!fs.existsSync(latest)) throw Error('No Prompt 15 v2 run exists');
  return path.resolve(readJson(latest).directory);
}
function events(directory) {
  const file = path.join(directory, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

export function renderProgress(directory = latestDirectory()) {
  const state = readJson(path.join(directory, 'state.json'));
  const all = events(directory);
  const messages = all.filter(row => row.kind === 'agent_message');
  const sessions = new Map();
  for (const row of all.filter(event => event.threadId)) {
    const key = row.threadId ?? 'unknown';
    if (!sessions.has(key)) sessions.set(key, {role: row.role ?? 'unknown', status: 'running', messages: []});
    const session = sessions.get(key);
    if (row.role) session.role = row.role;
    if (row.kind === 'agent_message') session.messages.push(row);
    if (row.kind === 'human_input_required') session.status = 'input-required';
    if (row.kind === 'native_event' && row.method === 'turn/completed') session.status = row.status ?? 'completed';
    if (row.kind === 'role_completed') session.status = 'completed';
  }
  const lines = [
    'PROMPT 15 — simple-loop progress v2',
    `생성 시각: ${kst(new Date().toISOString())}`,
    `상태: ${state.status.toUpperCase()} · 단계: ${state.phase} · 태스크: ${state.taskId} · 제품 attempt: ${state.productAttempt}/${state.maxProductAttempts}`,
    `마지막 상태 변경: ${kst(state.updatedAt)}`,
    `현재 세션: ${state.activeTurn ? `${state.activeTurn.role} · ${state.activeTurn.threadId} · ${kst(state.activeTurn.startedAt)}` : '없음'}`,
    `누적 제품 검증 실패: ${state.failures.length}`,
    '',
    '[세션별 최근 메시지 최대 5개]',
  ];
  if (!sessions.size) lines.push('  메시지 없음');
  for (const [threadId, session] of sessions) {
    lines.push(`- ${session.role} · ${session.status} · ${threadId}`);
    if (!session.messages.length) lines.push('  메시지 없음');
    for (const row of session.messages.slice(-5)) lines.push(`  [${kst(row.at)}] ${brief(row.text, 500)}`);
  }
  lines.push('', '[전체 최근 메시지 5개]');
  for (const row of messages.slice(-5)) lines.push(`- [${kst(row.at)}] ${brief(row.text, 700)}`);
  if (!messages.length) lines.push('  메시지 없음');
  if (state.lastVerification) {
    lines.push('', '[최근 독립 검증]', `판정: ${state.lastVerification.value.verdict}`, `요약: ${state.lastVerification.value.summary}`);
  }
  if (state.operatingIncident) {
    const acknowledged = Boolean(state.operatingIncident.acknowledgedAt);
    lines.push('', acknowledged ? '[과거 운영 장애 — 조치 후 재개됨]' : '[운영 장애 — 자동 복구 없음]', brief(state.operatingIncident.message));
  }
  return `${lines.join('\n')}\n`;
}

export function writeProgress(directory = latestDirectory()) {
  const text = renderProgress(directory);
  fs.writeFileSync(path.join(directory, 'progress.txt'), text);
  return text;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'once';
  if (command === 'once') process.stdout.write(writeProgress());
  else if (command === 'watch') {
    const update = () => { try { writeProgress(); } catch (error) { process.stderr.write(`${error.message}\n`); } };
    update(); setInterval(update, 5000);
  } else throw Error('Use once or watch');
}
