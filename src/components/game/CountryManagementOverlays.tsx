import type {EconomyViewModel, NewsItemViewModel, PoliticsViewModel} from "@/lib/game-ui/contracts";
import {GameEmptyState, GameLoadingState, GameStatusBadge} from "./GamePanel";

function CountryHeader({countryName, code, mapColor}: Readonly<{
  countryName: string;
  code: string;
  mapColor: string | null;
}>) {
  return (
    <header className="game-management-country">
      <span className="game-management-country__color" style={{background: mapColor ?? "transparent"}} aria-hidden="true"/>
      <div><h3>{countryName}</h3><span>{code}</span></div>
    </header>
  );
}

function UnknownValue() {
  return <span className="game-management-unknown">데이터 연결 예정</span>;
}

function EventList({title, events}: Readonly<{title: string; events: readonly NewsItemViewModel[]}>) {
  return (
    <section className="game-management-section" aria-labelledby="management-events-title">
      <div className="game-management-section__heading">
        <h3 id="management-events-title">{title}</h3>
        <GameStatusBadge>{events.length}건</GameStatusBadge>
      </div>
      {events.length === 0 ? (
        <GameEmptyState title="기록된 사건 없음" description="해당 국가와 관련된 사건이 아직 기록되지 않았습니다."/>
      ) : (
        <ol className="game-management-events">
          {events.map((event) => <li key={event.eventId}>
            <time dateTime={event.date}>{event.date}</time>
            <strong>{event.title}</strong>
            <p>{event.narrative}</p>
          </li>)}
        </ol>
      )}
    </section>
  );
}

export function PoliticsOverlay({model}: Readonly<{model: PoliticsViewModel}>) {
  if (model.loading) return <div data-testid="politics-overlay"><GameLoadingState title="정치 데이터 불러오는 중"/></div>;
  return <div className="game-management-view" data-testid="politics-overlay">
    <CountryHeader countryName={model.country.nameKo} code={model.country.code} mapColor={model.country.mapColor}/>
    <GameStatusBadge tone="warning">{model.unavailableReason ?? "정치 데이터 미연결"}</GameStatusBadge>
    <section className="game-management-section" aria-labelledby="politics-overview-title">
      <h3 id="politics-overview-title">정치 개요</h3>
      <dl className="game-management-facts">
        <div><dt>정치 체제</dt><dd>{model.regimeName ?? <UnknownValue/>}</dd></div>
        <div><dt>국가 지도자</dt><dd>{model.leaderName ?? <UnknownValue/>}</dd></div>
      </dl>
    </section>
    <section className="game-management-section" aria-labelledby="domestic-situation-title">
      <h3 id="domestic-situation-title">현재 국내 상황</h3>
      {model.domesticSituation ? <p>{model.domesticSituation}</p> : <UnknownValue/>}
    </section>
    <EventList title="최근 국내 사건" events={model.recentDomesticEvents}/>
    <section className="game-management-section" aria-labelledby="politics-extension-title">
      <h3 id="politics-extension-title">후속 확장</h3>
      <p className="game-management-note">정치 체제와 지도자 도메인이 연결되면 이 영역에 권위 데이터를 표시합니다.</p>
    </section>
  </div>;
}

export function EconomyOverlay({model}: Readonly<{model: EconomyViewModel}>) {
  if (model.loading) return <div data-testid="economy-overlay"><GameLoadingState title="경제 데이터 불러오는 중"/></div>;
  return <div className="game-management-view" data-testid="economy-overlay">
    <CountryHeader countryName={model.country.nameKo} code={model.country.code} mapColor={model.country.mapColor}/>
    <GameStatusBadge tone="warning">{model.unavailableReason ?? "경제 데이터 미연결"}</GameStatusBadge>
    <section className="game-management-section" aria-labelledby="economy-overview-title">
      <h3 id="economy-overview-title">경제 개요</h3>
      <dl className="game-management-facts">
        <div><dt>인구</dt><dd>{model.population === null ? <UnknownValue/> : model.population.toLocaleString("ko-KR")}</dd></div>
        <div><dt>요약</dt><dd>{model.summary ?? <UnknownValue/>}</dd></div>
      </dl>
    </section>
    <section className="game-management-section" aria-labelledby="economy-metrics-title">
      <h3 id="economy-metrics-title">주요 지표</h3>
      <div className="game-economy-metrics">
        {model.metrics.map((metric) => <article key={metric.key}>
          <span>{metric.label}</span>
          <strong>{metric.dataAvailable && metric.value !== null
            ? `${metric.value.toLocaleString("ko-KR")}${metric.unit ?? ""}`
            : "—"}</strong>
          {!metric.dataAvailable && <small>데이터 연결 예정</small>}
        </article>)}
      </div>
    </section>
    <EventList title="최근 경제 사건" events={model.recentEconomicEvents}/>
  </div>;
}
