import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderProgress} from './prompt15-progress.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.tmp/prompt15-orchestrator-v2');
const configFile = path.join(runtime, 'discord.json');
const stateFile = path.join(runtime, 'discord-state.json');
const latestFile = path.join(root, 'reports/prompt15/orchestrator-v2/latest.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function compactDiscordProgress(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  const generated = lines.find(line => line.startsWith('생성 시각:'))?.match(/(\d{2}:\d{2}:\d{2}) KST/)?.[1] ?? '-';
  const status = lines.find(line => line.startsWith('상태:'))?.match(/^상태: (\S+) · 단계: (\S+) · 태스크: (\S+) · 제품 attempt: (\S+)/);
  const session = lines.find(line => line.startsWith('현재 세션:'))?.match(/^현재 세션: ([^·]+) · ([^·]+) · .*?(\d{2}:\d{2}:\d{2}) KST$/);
  const header = [
    'PROMPT 15 · simple-loop v2',
    status ? `${status[1]} / ${status[2].toUpperCase()} · ${status[3]} · attempt ${status[4]}` : '상태 확인 불가',
    `갱신 ${generated} KST`,
    session ? `세션 ${session[1].trim()} · ${session[2].trim().slice(0, 8)}… · 시작 ${session[3]}` : '세션 없음',
  ];
  const globalIndex = lines.indexOf('[전체 최근 메시지 5개]');
  const sectionEnd = globalIndex < 0 ? -1 : lines.findIndex((line, index) => index > globalIndex && /^\[.+\]$/.test(line));
  const globalLines = globalIndex < 0 ? [] : lines
    .slice(globalIndex + 1, sectionEnd < 0 ? undefined : sectionEnd)
    .filter(line => line.startsWith('- '))
    .slice(-3)
    .reverse()
    .map(line => {
      const match = line.match(/^- \[.*?(\d{2}:\d{2}:\d{2}) KST\] (.*)$/);
      const compact = match ? `${match[1]}  ${match[2]}` : line.replace(/^- /, '');
      return `• ${compact.length <= 360 ? compact : `${compact.slice(0, 360)}…`}`;
    });
  const body = [...header, '', '[최근 진행]', ...(globalLines.length ? globalLines : ['• 메시지 없음'])].join('\n');
  return body.length <= 1880 ? body : `${body.slice(0, 1820)}\n… progress.txt에서 전체 내용을 확인하세요.`;
}
function message(text) {
  const compact = compactDiscordProgress(text);
  return {content: `\`\`\`text\n${compact}\n\`\`\``};
}

async function update() {
  if (!fs.existsSync(configFile)) throw Error('Discord config is missing');
  if (!fs.existsSync(stateFile)) throw Error('Discord state with the fixed messageId is missing; refusing to create message spam');
  if (!fs.existsSync(latestFile)) return;
  const config = read(configFile), state = read(stateFile), latest = read(latestFile);
  if (!config.webhookUrl || !state.messageId) throw Error('webhookUrl and fixed messageId are required');
  const text = renderProgress(path.resolve(latest.directory));
  const response = await fetch(`${config.webhookUrl}/messages/${state.messageId}`, {
    method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify(message(text)),
  });
  if (!response.ok) throw Error(`Discord edit failed: ${response.status}`);
  state.lastEditAt = new Date().toISOString(); state.lastError = null; write(stateFile, state);
}

async function create() {
  if (!fs.existsSync(configFile)) throw Error('Discord config is missing');
  if (!fs.existsSync(latestFile)) throw Error('No Prompt 15 v2 run exists');
  const config = read(configFile), latest = read(latestFile);
  if (!config.webhookUrl) throw Error('webhookUrl is required');
  const text = renderProgress(path.resolve(latest.directory));
  const response = await fetch(`${config.webhookUrl}?wait=true`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(message(text)),
  });
  if (!response.ok) throw Error(`Discord create failed: ${response.status}`);
  const created = await response.json();
  if (!created.id) throw Error('Discord create returned no message id');
  write(stateFile, {version: 1, messageId: created.id, lastEditAt: new Date().toISOString(), lastError: null});
  process.stdout.write(`${JSON.stringify({messageId: created.id})}\n`);
}

async function main() {
  const command = process.argv[2] ?? 'once';
  if (command === 'create') { await create(); return; }
  const config = read(configFile);
  const intervalMs = Math.max(5000, Number(config.intervalSeconds ?? 20) * 1000);
  const once = async () => {
    try { await update(); }
    catch (error) {
      const state = fs.existsSync(stateFile) ? read(stateFile) : {version: 1};
      state.lastError = error.message; state.lastErrorAt = new Date().toISOString(); write(stateFile, state);
      process.stderr.write(`${error.message}\n`);
    }
  };
  await once();
  if (command === 'watch') setInterval(once, intervalMs);
  else if (command !== 'once') throw Error('Use create, once, or watch');
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
