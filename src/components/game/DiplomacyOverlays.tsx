"use client";

import {useEffect, useRef, useState} from "react";

import type {
  BilateralRelationshipViewModel,
  CountryViewModel,
  DiplomacyChannelViewModel,
  DiplomacyConnectionState,
  DiplomacySendRequest,
  DirectionalRelationshipViewModel,
} from "@/lib/game-ui/contracts";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {GameEmptyState, GameStatusBadge} from "./GamePanel";

export type DiplomacySendHandler = (
  request: DiplomacySendRequest,
  signal: AbortSignal,
) => void | Promise<void>;

const connectionPresentation: Record<DiplomacyConnectionState, Readonly<{
  label: string;
  tone: "neutral" | "active" | "warning" | "error";
}>> = {
  disconnected: {label: "외교 채널 API 연결 예정", tone: "warning"},
  connecting: {label: "외교 채널 연결 중", tone: "active"},
  ready: {label: "외교 채널 사용 가능", tone: "active"},
  sending: {label: "메시지 전달 중", tone: "active"},
  error: {label: "외교 채널 오류", tone: "error"},
};

const messageRoleLabel = {player: "플레이어", foreign: "상대국", system: "시스템"} as const;

function RelationshipDirection({model}: Readonly<{model: DirectionalRelationshipViewModel}>) {
  const label = `${model.fromCountry.nameKo} → ${model.toCountry.nameKo}`;
  return <div className="game-relationship-direction">
    <div><span>{label}</span><strong>{model.score === null ? "알 수 없음" : model.score}</strong></div>
    {model.dataAvailable && model.score !== null ? (
      <div className="game-relationship-meter" role="meter" aria-label={`${label} 관계`} aria-valuemin={-100} aria-valuemax={100} aria-valuenow={model.score}>
        <i style={{width: `${(model.score + 100) / 2}%`}}/>
      </div>
    ) : <p>관계 데이터 연결 예정</p>}
  </div>;
}

function BilateralRelationship({model}: Readonly<{model: BilateralRelationshipViewModel}>) {
  return <div className="game-relationship-pair">
    <RelationshipDirection model={model.playerToForeign}/>
    <RelationshipDirection model={model.foreignToPlayer}/>
  </div>;
}

export function CountryOverlay({
  model,
  onOpenPolitics,
  onOpenDiplomacy,
}: Readonly<{
  model: CountryViewModel;
  onOpenPolitics(): void;
  onOpenDiplomacy(countryId: ActiveCountryId): void;
}>) {
  return <div className="game-management-view" data-testid="country-overlay">
    <header className="game-country-detail__header">
      <span className="game-management-country__color" style={{background: model.country.mapColor ?? "transparent"}} aria-hidden="true"/>
      <div><h3>{model.country.nameKo}</h3><p>{model.officialNameKo}</p><span>{model.country.code} · {model.englishName}</span></div>
    </header>
    <dl className="game-management-facts">
      <div><dt>국가 지위</dt><dd>{model.politicalStatus}</dd></div>
      <div><dt>수도</dt><dd>{model.capitalKo ?? "데이터 연결 예정"}<br/><small>{model.capitalEn ?? "데이터 연결 예정"}</small></dd></div>
      <div><dt>지역</dt><dd>{model.region ?? "데이터 연결 예정"}</dd></div>
      <div><dt>지도 색상</dt><dd>{model.country.mapColor ?? "데이터 없음"}</dd></div>
    </dl>
    {model.isPlayerCountry ? (
      <section className="game-management-section">
        <h3>플레이 국가</h3>
        <p className="game-management-note">현재 플레이 중인 국가입니다. 국내 정보는 정치 화면에서 확인할 수 있습니다.</p>
        <button type="button" className="game-primary-action" onClick={onOpenPolitics}>정치 화면 열기</button>
      </section>
    ) : (
      <section className="game-management-section" aria-labelledby="relationship-title">
        <h3 id="relationship-title">양방향 관계</h3>
        {model.relationship && <BilateralRelationship model={model.relationship}/>} 
        <button type="button" className="game-primary-action" onClick={() => onOpenDiplomacy(model.country.countryId as ActiveCountryId)}>외교 채널 열기</button>
      </section>
    )}
    <section className="game-management-section">
      <div className="game-management-section__heading"><h3>최근 관련 사건</h3><GameStatusBadge>{model.recentEvents.length}건</GameStatusBadge></div>
      {model.recentEvents.length === 0 ? <GameEmptyState title="관련 사건 없음" description="이 국가와 관련된 기록된 사건이 없습니다."/> : <ol className="game-management-events">
        {model.recentEvents.map((event) => <li key={event.eventId}><time dateTime={event.date}>{event.date}</time><strong>{event.title}</strong><p>{event.narrative}</p></li>)}
      </ol>}
    </section>
    <section className="game-management-section">
      <h3>관련 진행 중 전쟁</h3>
      {!model.warsDataAvailable
        ? <p className="game-management-note">전쟁 데이터 연결 예정</p>
        : model.relatedWars.length === 0 && <p className="game-management-note">관련 전쟁이 없습니다.</p>}
    </section>
  </div>;
}

export function DiplomacyOverlay({
  model,
  onSelectCountry,
  onSend,
}: Readonly<{
  model: DiplomacyChannelViewModel;
  onSelectCountry(countryId: ActiveCountryId): void;
  onSend?: DiplomacySendHandler | null;
}>) {
  const [draft, setDraft] = useState("");
  const [intentId, setIntentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const sendAbortController = useRef<AbortController | null>(null);
  useEffect(() => { setDraft(""); setIntentId(null); }, [model.counterpart?.countryId]);
  useEffect(() => () => sendAbortController.current?.abort(), []);
  const locked = model.connectionState === "sending" || submitting;
  const canSubmit = model.connectionState === "ready"
    && model.canSend
    && model.counterpart !== null
    && draft.trim().length > 0
    && onSend != null
    && !locked;
  const presentation = connectionPresentation[model.connectionState];
  const connectionDetail = model.connectionMessage.trim();
  const send = async () => {
    if (!canSubmit || !model.counterpart || !onSend) return;
    const controller = new AbortController();
    sendAbortController.current?.abort();
    sendAbortController.current = controller;
    setSubmitting(true);
    try {
      await onSend({
        counterpartCountryId: model.counterpart.countryId as ActiveCountryId,
        text: draft,
        intentId,
      }, controller.signal);
    } finally {
      if (sendAbortController.current === controller) sendAbortController.current = null;
      setSubmitting(false);
    }
  };
  return <div className="game-diplomacy" data-testid="diplomacy-overlay">
    <nav className="game-diplomacy__countries" aria-label="외교 대상 국가">
      <h3>대상 국가</h3>
      {model.availableCounterparts.map((country) => <button
        type="button"
        key={country.countryId}
        data-active={country.countryId === model.counterpart?.countryId ? "" : undefined}
        onClick={() => onSelectCountry(country.countryId as ActiveCountryId)}
      ><i style={{background: country.mapColor ?? "transparent"}} aria-hidden="true"/><span>{country.nameKo}</span><small>{country.code}</small></button>)}
    </nav>
    <div className="game-diplomacy__channel">
      {model.counterpart === null ? <GameEmptyState title="외교 대상 선택" description="왼쪽 목록에서 대화할 국가를 선택하세요."/> : <>
        <header><div><span>외교 채널</span><h3>{model.counterpart.nameKo}</h3></div><GameStatusBadge tone={presentation.tone}>{presentation.label}</GameStatusBadge></header>
        {model.relationship && <BilateralRelationship model={model.relationship}/>} 
        <section className="game-diplomacy__transcript" aria-label="외교 대화 기록">
          {model.transcript.length === 0 ? <GameEmptyState title="대화 기록 없음" description="외교 채널 API가 연결되면 대화가 여기에 표시됩니다."/> : model.transcript.map((message) => <article key={message.messageId} data-role={message.role}>
            <header><strong>{messageRoleLabel[message.role]}</strong><time dateTime={Number.isNaN(Date.parse(message.createdAt)) ? undefined : message.createdAt}>{message.createdAt}</time></header>
            <p>{message.text}</p>
          </article>)}
        </section>
        <div className="game-diplomacy__intents" aria-label="빠른 의도">
          {model.quickIntents.map((intent) => <button type="button" key={intent.id} disabled={locked} aria-pressed={intentId === intent.id} onClick={() => setIntentId(intent.id)}>{intent.label}</button>)}
        </div>
        <label className="game-diplomacy__composer">외교 메시지
          <textarea value={draft} disabled={locked} onChange={(event) => setDraft(event.target.value)} placeholder="전달할 메시지를 작성하세요"/>
        </label>
        <div className="game-diplomacy__connection">
          {connectionDetail && connectionDetail !== presentation.label
            ? <span>{connectionDetail}</span>
            : null}
          <button type="button" disabled={!canSubmit} onClick={() => void send()}>전송</button>
        </div>
      </>}
    </div>
  </div>;
}
