"use client";

import {useMemo, useState} from "react";

import {filterNewsItems, type GameNewsViewModel, type NewsFilter} from "@/lib/game-ui/news-projection";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {GameEmptyState, GameStatusBadge} from "./GamePanel";

const filterOptions: readonly Readonly<{value: NewsFilter; label: string}>[] = [
  {value: "all", label: "전체"},
  {value: "minor", label: "일반"},
  {value: "notable", label: "주목"},
  {value: "major", label: "중요"},
  {value: "transformative", label: "변혁"},
];

const significanceLabel = {minor: "일반", notable: "주목", major: "중요", transformative: "변혁"} as const;
const significanceTone = {minor: "neutral", notable: "active", major: "warning", transformative: "error"} as const;

export function NewsOverlay({model, activeCountryIds, onSelectEvent, onOpenCountry}: Readonly<{
  model: GameNewsViewModel;
  activeCountryIds?: ReadonlySet<string>;
  onSelectEvent(eventId: string): void;
  onOpenCountry(countryId: ActiveCountryId): void;
}>) {
  const [filter, setFilter] = useState<NewsFilter>("all");
  const filtered = useMemo(() => filterNewsItems(model.items, filter), [filter, model.items]);
  const visibleSelected = filtered.find((item) => item.eventId === model.selectedEventId) ?? filtered[0] ?? null;
  if (model.items.length === 0) {
    return <div className="game-news" data-testid="news-overlay"><GameEmptyState title="기록된 뉴스 없음" description={model.unavailableReason ?? "턴을 진행하면 확정된 사건이 여기에 표시됩니다."}/></div>;
  }
  return <div className="game-news" data-testid="news-overlay">
    <div className="game-news__filters" aria-label="뉴스 중요도 필터">{filterOptions.map((option) => <button type="button" key={option.value} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>)}</div>
    <div className="game-news__layout">
      <ol className="game-news__list" aria-label="뉴스 목록">{filtered.map((item) => <li key={item.eventId}><button type="button" data-active={item.eventId === visibleSelected?.eventId ? "" : undefined} onClick={() => onSelectEvent(item.eventId)}><span><time dateTime={item.date}>{item.date}</time><GameStatusBadge tone={significanceTone[item.significance]}>{significanceLabel[item.significance]}</GameStatusBadge></span><strong>{item.title}</strong><p>{item.narrative}</p></button></li>)}</ol>
      <div className="game-news__detail">
        {visibleSelected ? <article>
          <header><div><time dateTime={visibleSelected.date}>{visibleSelected.date}</time><h3>{visibleSelected.title}</h3></div><GameStatusBadge tone={significanceTone[visibleSelected.significance]}>{significanceLabel[visibleSelected.significance]}</GameStatusBadge></header>
          <p>{visibleSelected.narrative}</p>
          <dl className="game-management-facts"><div><dt>분류</dt><dd>{visibleSelected.category}</dd></div><div><dt>지도 변화</dt><dd>{visibleSelected.mapChangeAvailable ? "지도에 반영됨" : "즉시 지도 변화 없음"}</dd></div><div><dt>확인 상태</dt><dd>{visibleSelected.acknowledged ? "확인됨" : "미확인"}</dd></div></dl>
          <div className="game-news__countries" aria-label="관련 국가">{visibleSelected.relatedCountryIds.map((countryId) => {
            const active = activeCountryIds?.has(countryId) ?? true;
            return <button type="button" key={countryId} disabled={!active} onClick={() => active && onOpenCountry(countryId as ActiveCountryId)}>{active ? `${countryId} 보기` : `${countryId} · 퇴역 국가`}</button>;
          })}</div>
        </article> : <GameEmptyState title="해당 중요도의 뉴스 없음" description="다른 중요도 필터를 선택하세요."/>}
      </div>
    </div>
    {model.turnResult && <section className="game-turn-result" aria-labelledby="turn-result-title">
      <header><span>TURN RESULT</span><h3 id="turn-result-title">{model.turnResult.period}</h3></header>
      <ResultGroup title="행동 결과" values={model.turnResult.outcomes}/>
      <ResultGroup title="관련 국가 반응" values={model.turnResult.reactions} empty="중복되지 않은 별도 반응이 없습니다."/>
      <ResultGroup title="지도 변화" values={model.turnResult.mapChanges}/>
      <ResultGroup title="진행 중 상황" values={model.turnResult.continuing} empty="남은 문제가 없습니다."/>
      <div><h4>참모 요약</h4><p>{model.turnResult.advisorSummary}</p></div>
    </section>}
  </div>;
}

function ResultGroup({title, values, empty}: Readonly<{title: string; values: readonly string[]; empty?: string}>) {
  return <div><h4>{title}</h4>{values.length > 0 ? values.map((value, index) => <p key={`${index}:${value}`}>{value}</p>) : <p>{empty ?? "기록 없음"}</p>}</div>;
}
