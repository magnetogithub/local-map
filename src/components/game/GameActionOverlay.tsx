"use client";

import {useState} from "react";

import type {SimulationTurnController} from "@/lib/simulation/client/use-simulation-turn-controller";
import {targetDateForCustomInput, targetDateForPreset, type TimeAdvancePreset} from "@/lib/simulation/client/turn-request";
import {MAX_PLAYER_ACTION_LENGTH} from "@/lib/simulation/simulation-contract-primitives";

const phaseLabel = {
  idle: "대기 중",
  requesting: "역사 전개 판정 중",
  looking_up: "세계 정보 확인 중",
  repairing: "판정 정합성 확인 중",
  committing: "결과 적용 중",
  committed: "진행 완료",
  failed: "진행 실패",
  cancelled: "진행 중단됨",
} as const;

const advancePresets: readonly Readonly<{preset: Exclude<TimeAdvancePreset, "next_event">; label: string}>[] = [
  {preset: "day", label: "1일"},
  {preset: "week", label: "1주"},
  {preset: "month", label: "1개월"},
];

type AdvanceSelection = Exclude<TimeAdvancePreset, "next_event"> | "custom";

function customDateError(currentDate: string, targetDate: string): string | null {
  if (!targetDate) return "목표 날짜를 입력하세요.";
  try {
    targetDateForCustomInput(currentDate, targetDate);
    return null;
  } catch {
    return "목표 날짜는 현재 날짜보다 뒤인 유효한 ISO 날짜여야 하며 최대 366일까지 지정할 수 있습니다.";
  }
}

export function GameActionOverlay({controller, advanceBlocked = false, onOpenNews}: Readonly<{
  controller: SimulationTurnController;
  advanceBlocked?: boolean;
  onOpenNews?(eventId?: string): void;
}>) {
  const [composing, setComposing] = useState(false);
  const [advanceSelection, setAdvanceSelection] = useState<AdvanceSelection>("month");
  const [customTargetDate, setCustomTargetDate] = useState("");
  const [customTouched, setCustomTouched] = useState(false);
  const [advanceWithoutActions, setAdvanceWithoutActions] = useState(false);
  const {
    snapshot: activeSnapshot,
    actionDraft: text,
    setActionDraft: setText,
    queuedActions: queued,
    turn,
    report,
    lifecycleNotice,
    running,
    canQueue,
    canUndo,
    canRedo,
    queueAction: queue,
    cancelAction: cancel,
    advance,
    advanceToDate,
    stop,
    retry,
    undo,
    redo,
  } = controller;

  if (!activeSnapshot) {
    return <section className="simulation-panel" aria-label="대체역사 진행"><p className="simulation-empty">플레이 국가를 먼저 선택하면 국가 행동과 시간 진행을 사용할 수 있습니다.</p></section>;
  }

  const currentDate = activeSnapshot.simulation.currentDate;
  const dateError = advanceSelection === "custom" ? customDateError(currentDate, customTargetDate) : null;
  const hasQueuedActions = queued.length > 0;
  const canStart = !running && !advanceBlocked && (hasQueuedActions || advanceWithoutActions) && dateError === null;
  const startAdvance = async () => {
    if (advanceSelection === "custom") setCustomTouched(true);
    if (!canStart) return;
    if (advanceSelection === "custom") await advanceToDate(customTargetDate);
    else await advance(advanceSelection);
  };
  const retryable = turn.phase === "failed" || turn.phase === "cancelled";
  const staleFailure = turn.errorCode === "STALE_STATE" || turn.errorCode === "STALE_REVISION_PAIR";

  return <section className="simulation-panel game-action-overlay" aria-label="대체역사 진행">
    <div className="simulation-heading"><div><span>ALTERNATE HISTORY</span><strong>국가 행동</strong></div><time dateTime={currentDate}>{currentDate}</time></div>
    <label htmlFor="game-player-action">현재 플레이 국가가 시도할 행동</label>
    <textarea id="game-player-action" value={text} maxLength={MAX_PLAYER_ACTION_LENGTH} disabled={running} placeholder="예: 오스트리아와 통일 협상을 시작한다" onChange={(event) => setText(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing && !event.nativeEvent.isComposing) { event.preventDefault(); queue(); } }}/>
    <div className="composer-meta"><span>{text.length}/{MAX_PLAYER_ACTION_LENGTH}</span><button type="button" onClick={queue} disabled={!canQueue}>대기열에 추가</button></div>
    <div className="action-queue" aria-label="행동 대기열">{queued.length === 0 ? <p>대기 중인 행동이 없습니다. 행동 없이 시간만 진행할 수 있습니다.</p> : queued.map((action) => <div key={action.actionId}><span>{action.text}</span><button type="button" onClick={() => cancel(action.actionId)} disabled={running}>취소</button></div>)}</div>

    <fieldset className="game-advance-controls" disabled={running}>
      <legend>진행할 시간</legend>
      <div className="time-controls">{advancePresets.map(({preset, label}) => <button key={preset} type="button" aria-pressed={advanceSelection === preset} onClick={() => { setAdvanceSelection(preset); setCustomTouched(false); }}>{label}</button>)}</div>
      <label className="game-custom-date">목표 날짜 직접 입력
        <input type="date" value={customTargetDate} min={targetDateForPreset(activeSnapshot.simulation, "day")} aria-invalid={advanceSelection === "custom" && customTouched && dateError !== null} aria-describedby="game-custom-date-error" onFocus={() => setAdvanceSelection("custom")} onChange={(event) => { setAdvanceSelection("custom"); setCustomTargetDate(event.target.value); setCustomTouched(true); }}/>
      </label>
      <p id="game-custom-date-error" className="game-field-message" role={advanceSelection === "custom" && customTouched && dateError ? "alert" : undefined}>{advanceSelection === "custom" && customTouched ? dateError : "YYYY-MM-DD 형식, 현재 날짜 다음 날부터 최대 366일"}</p>
      <label className="game-time-only-confirm"><input type="checkbox" checked={advanceWithoutActions} disabled={running || hasQueuedActions} onChange={(event) => setAdvanceWithoutActions(event.target.checked)}/>행동 없이 시간만 진행</label>
      {advanceBlocked && <p className="game-field-message" role="alert">미확인 주요 사건을 모두 확인해야 다음 진행을 시작할 수 있습니다.</p>}
      <button className="game-advance-submit" type="button" disabled={!canStart} onClick={() => void startAdvance()}>진행 시작</button>
    </fieldset>

    <div className="turn-status" data-phase={turn.phase} data-error-code={turn.errorCode ?? undefined} role="status"><span>{phaseLabel[turn.phase]}{turn.phase === "failed" && turn.errorCode ? ` (${turn.errorCode})` : ""}</span>{running && <button type="button" onClick={stop}>Stop</button>}{retryable && <button type="button" onClick={() => void retry()}>Retry</button>}</div>
    {turn.draft && <p className="turn-draft" aria-label="임시 초안" aria-live="polite">{turn.draft}</p>}
    {turn.phase === "failed" && <p className="game-turn-error" role="alert">{staleFailure ? "진행 중 세계 상태가 변경되어 결과를 적용하지 않았습니다. 현재 상태에서 다시 시도하세요." : "진행에 실패했습니다. 이전에 확정된 세계 상태는 유지됩니다."}</p>}
    {turn.phase === "cancelled" && <p className="game-turn-error" role="alert">진행을 중단했습니다. 이전 상태에서 다시 시도할 수 있습니다.</p>}
    {lifecycleNotice && <p className="simulation-lifecycle-notice" aria-live="polite">{lifecycleNotice}</p>}
    {report && <section className="game-action-result" aria-label="최근 턴 결과 요약"><span>TURN RESULT</span><strong>{report.period}</strong><p>행동 결과 {report.outcomes.length}건 · 사건 {report.events.length}건 · 지도 변화 {report.mapChanges.length}건</p><p>{report.advisorSummary}</p>{onOpenNews && <button type="button" onClick={() => onOpenNews(report.events[0]?.eventId)}>뉴스에서 전체 결과 보기</button>}</section>}
    <div className="game-history-controls"><button className="turn-undo" type="button" onClick={undo} disabled={!canUndo}>마지막 턴 되돌리기</button><button className="turn-redo" type="button" onClick={redo} disabled={!canRedo}>다시 실행</button></div>
  </section>;
}
