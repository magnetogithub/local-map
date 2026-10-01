"use client";

import {useState} from "react";

import type {WarsViewModel} from "@/lib/game-ui/contracts";
import type {GameUiSettingKey, GameUiSettings} from "@/lib/game-ui/ui-settings";
import {GameEmptyState, GameLoadingState, GameStatusBadge} from "./GamePanel";

export function WarsOverlay({model}: Readonly<{model: WarsViewModel}>) {
  const [selectedWarId, setSelectedWarId] = useState<string | null>(model.wars[0]?.warId ?? null);
  const [visibleWarIds, setVisibleWarIds] = useState<ReadonlySet<string>>(() => new Set(
    model.wars.filter((war) => war.mapLayerVisible).map((war) => war.warId),
  ));
  const selected = model.wars.find((war) => war.warId === selectedWarId) ?? model.wars[0] ?? null;
  if (model.loading) return <div className="game-war-view" data-testid="wars-overlay"><GameLoadingState title="전쟁 데이터 불러오는 중"/><WarLegend/></div>;
  if (!model.dataAvailable && model.wars.length === 0) return <div className="game-war-view" data-testid="wars-overlay">
    <GameEmptyState title="진행 중인 전쟁 데이터 없음" description={model.unavailableReason ?? "전쟁 도메인 연결 예정"}/>
    <WarLegend/>
  </div>;
  return <div className="game-war-view" data-testid="wars-overlay">
    <div className="game-war-list" aria-label="진행 중인 전쟁">
      {model.wars.map((war) => <button type="button" key={war.warId} data-active={war.warId === selected?.warId ? "" : undefined} onClick={() => setSelectedWarId(war.warId)}>
        <strong>{war.name}</strong><span>{war.startDate ?? "시작일 미상"}</span><GameStatusBadge tone={war.status === "ongoing" ? "warning" : "neutral"}>{war.status}</GameStatusBadge>
      </button>)}
    </div>
    {selected && <article className="game-war-detail">
      <header><div><span>전쟁 상세</span><h3>{selected.name}</h3></div><GameStatusBadge tone="warning">{selected.status}</GameStatusBadge></header>
      <dl className="game-management-facts">
        <div><dt>교전국</dt><dd>{selected.belligerents.map((country) => country.nameKo).join(" · ")}</dd></div>
        <div><dt>시작일</dt><dd>{selected.startDate ?? "데이터 없음"}</dd></div>
      </dl>
      <button
        type="button"
        className="game-primary-action"
        disabled={!selected.mapLayerAvailable}
        aria-pressed={visibleWarIds.has(selected.warId)}
        onClick={() => setVisibleWarIds((current) => {
          const next = new Set(current);
          if (next.has(selected.warId)) next.delete(selected.warId); else next.add(selected.warId);
          return next;
        })}
      >{selected.mapLayerAvailable ? "전쟁 지도 표시" : "전쟁 지도 데이터 없음"}</button>
      <section><h4>최근 관련 사건</h4>{selected.recentEvents.length === 0 ? <p className="game-management-note">기록된 관련 사건이 없습니다.</p> : selected.recentEvents.map((event) => <p key={event.eventId}>{event.date} · {event.title}</p>)}</section>
    </article>}
    <WarLegend/>
  </div>;
}

function WarLegend() {
  return <section className="game-war-legend" aria-label="전쟁 지도 범례">
    <h3>전쟁 지도 범례</h3><span><i data-kind="front"/>전선</span><span><i data-kind="occupation"/>점령</span><span><i data-kind="belligerent"/>교전국</span>
    <p>권위 있는 전쟁 지리 데이터가 연결될 때 이 슬롯에 표시됩니다.</p>
  </section>;
}

export function SaveOverlay({countryName, currentDate, turnNumber}: Readonly<{
  countryName: string;
  currentDate: string | null;
  turnNumber: number | null;
}>) {
  const [message, setMessage] = useState("서버 저장 기능은 백엔드 연결 후 제공됩니다.");
  return <div className="game-system-view" data-testid="save-overlay">
    <dl className="game-management-facts">
      <div><dt>플레이 국가</dt><dd>{countryName}</dd></div>
      <div><dt>현재 날짜</dt><dd>{currentDate ?? "—"}</dd></div>
      <div><dt>턴</dt><dd>{turnNumber ?? "—"}</dd></div>
    </dl>
    <button type="button" className="game-primary-action" onClick={() => setMessage("저장되지 않았습니다. 서버 저장 백엔드 연결이 필요합니다.")}>게임 저장</button>
    <p className="game-system-message" role="status">{message}</p>
  </div>;
}

const settingLabels: ReadonlyArray<Readonly<{key: GameUiSettingKey; label: string; description: string}>> = [
  {key: "showCountryLabels", label: "지도 국가명", description: "지도 위 국가 이름을 표시합니다."},
  {key: "showCapitalMarkers", label: "수도 마커", description: "수도 점과 이름을 표시합니다."},
  {key: "emphasizeBorders", label: "국경선 강조", description: "국가 경계선을 더 굵게 표시합니다."},
  {key: "showNewsNotifications", label: "뉴스 알림", description: "새 사건 알림을 표시합니다."},
  {key: "reduceMotion", label: "움직임 줄이기", description: "게임 UI 전환 효과를 제거합니다."},
];

export function SettingsOverlay({settings, onChange}: Readonly<{
  settings: GameUiSettings;
  onChange(key: GameUiSettingKey, value: boolean): void;
}>) {
  return <div className="game-settings" data-testid="settings-overlay">
    {settingLabels.map((setting) => <label key={setting.key}>
      <span><strong>{setting.label}</strong><small>{setting.description}</small></span>
      <input data-setting-key={setting.key} type="checkbox" checked={settings[setting.key]} onChange={(event) => onChange(setting.key, event.target.checked)}/>
    </label>)}
    <p className="game-management-note">설정은 현재 세션에만 적용되며 새로고침 후 유지되지 않습니다.</p>
  </div>;
}
