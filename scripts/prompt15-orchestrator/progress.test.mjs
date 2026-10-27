import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach, describe, expect, test} from 'vitest';
import {renderProgress} from '../../tools/prompt15-progress.mjs';
import {compactDiscordProgress} from '../../tools/prompt15-discord.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true}); });

describe('progress renderer', () => {
  test('shows per-session status, five recent messages, five global messages, and a bounded incident', () => {
    const directory = path.resolve('.tmp/prompt15-v2-progress-tests', randomUUID());
    roots.push(directory);
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify({
      status: 'operating_failure', phase: 'operating_failure', taskId: '15-18', productAttempt: 1,
      maxProductAttempts: 3, updatedAt: new Date().toISOString(), activeTurn: null, failures: [],
      operatingIncident: {message: 'X'.repeat(1000)},
    })}\n`);
    const rows = [];
    for (let index = 1; index <= 7; index += 1) rows.push({at: new Date().toISOString(), kind: 'agent_message', role: 'implementer', threadId: 'thread-1', text: `message-${index}`});
    rows.push({at: new Date().toISOString(), kind: 'native_event', role: 'implementer', threadId: 'thread-1', method: 'turn/completed', status: 'completed'});
    fs.writeFileSync(path.join(directory, 'events.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const rendered = renderProgress(directory);
    expect(rendered).toContain('implementer · completed · thread-1');
    expect(rendered).not.toContain('message-1');
    expect(rendered).not.toContain('message-2');
    expect(rendered).toContain('message-3');
    expect(rendered).toContain('message-7');
    expect(rendered).toContain('XXX…');
    expect(rendered.length).toBeLessThan(5000);
  });

  test('Discord summary puts the newest global message first instead of truncating it behind old sessions', () => {
    const text = [
      'PROMPT 15 — simple-loop progress v2', '생성 시각: now', '상태: RUNNING', '마지막 상태 변경: now',
      '현재 세션: verifier', '누적 제품 검증 실패: 0', '', '[세션별 최근 메시지 최대 5개]',
      `- implementer · completed`, `  ${'old '.repeat(600)}`, '', '[전체 최근 메시지 5개]',
      `- [old] ${'stale '.repeat(100)}`, '- [new] current verifier result', '', '[과거 운영 장애 — 조치 후 재개됨]', 'old error',
    ].join('\n');
    const compact = compactDiscordProgress(text);
    expect(compact).toContain('[new] current verifier result');
    expect(compact.indexOf('[new]')).toBeLessThan(compact.indexOf('[old]'));
    expect(compact).not.toContain('old error');
    expect(compact.length).toBeLessThanOrEqual(1880);
  });
});
