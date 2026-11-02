"use client";

import {getCountryPanelView} from "@/lib/projection/country-panel-projection";
import {useGameSetupStore} from "@/stores/game-setup-store";
import {CountryFlag} from "./CountryFlag";

type Props = Readonly<{
  onPlayerConfirmed?: (countryId: string) => void;
}>;

export function CountryPanel({onPlayerConfirmed}: Props = {}) {
  const selected = useGameSetupStore((state) => state.selectedCountryId);
  const player = useGameSetupStore((state) => state.playerCountryId);
  const projection = useGameSetupStore((state) => state.countryPanelProjection);
  const confirm = useGameSetupStore((state) => state.confirmPlayerCountry);
  const country = getCountryPanelView(projection, selected);
  const playerCountry = getCountryPanelView(projection, player);

  if (!country) {
    return (
      <aside className="panel">
        <div className="panel-empty">
          <div>
            <div className="compass">N</div>
            <p className="eyebrow">선택한 국가</p>
            <h2>국가를 선택하세요</h2>
            <p>지도에서 국가를 클릭하거나<br />상단 검색창을 이용하세요.</p>
            {playerCountry && <div className="badge">◆ 플레이 국가: {playerCountry.nameKo}</div>}
          </div>
        </div>
      </aside>
    );
  }

  const isPlayer = player === country.countryId;

  return (
    <aside className="panel" aria-labelledby="country-title">
      <p className="panel-kicker">선택한 국가 · {country.iso3}</p>
      <CountryFlag code={country.flagCode} name={country.nameKo} />
      <h1 id="country-title">{country.nameKo}</h1>
      <p className="country-en">{country.nameEn}</p>
      <div className="rule" />
      <dl className="facts">
        <div>
          <dt>수도</dt>
          <dd>{country.capitalKo}<br /><small>{country.capitalEn}</small></dd>
        </div>
        <div>
          <dt>지역</dt>
          <dd>{country.region}</dd>
        </div>
        <div>
          <dt>기준일</dt>
          <dd>2020년 1월 1일</dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>{country.playable ? "플레이 가능" : "플레이 불가"}</dd>
        </div>
      </dl>
      <div className="status">
        <i className="status-dot" />
        {isPlayer ? "현재 플레이 국가로 확정됨" : "플레이 가능한 국가입니다"}
      </div>
      <button
        className={`confirm ${isPlayer ? "confirmed" : ""}`}
        disabled={!country.playable}
        onClick={() => {
          confirm(country.countryId);
          onPlayerConfirmed?.(country.countryId);
        }}
        aria-label={`${country.nameKo}을(를) 플레이 국가로 선택`}
      >
        {isPlayer ? "플레이 국가로 선택됨" : "이 국가로 시작"}
      </button>
    </aside>
  );
}
