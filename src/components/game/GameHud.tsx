import type {GameHudViewModel} from "@/lib/game-ui/contracts";
import type {GameMenuOverlayKind} from "@/lib/game-ui/overlay-reducer";
import {GameStatusBadge, GameTooltip} from "./GamePanel";

const phaseLabel: Record<GameHudViewModel["phase"], string> = {
  idle: "대기",
  requesting: "국제 정세 분석 중",
  looking_up: "자료 확인 중",
  repairing: "결과 검증 중",
  committing: "세계 반영 중",
  committed: "진행 완료",
  failed: "실패",
  cancelled: "중단됨",
};

const value = (input: number | null) => input === null ? "—" : input.toLocaleString("ko-KR");

export function GameHud({
  model,
  onOpen,
  onStop,
  onRetry,
  turnDraft = "",
  turnErrorCode = null,
}: Readonly<{
  model: GameHudViewModel;
  onOpen(kind: GameMenuOverlayKind): void;
  onStop(): void;
  onRetry?(): void;
  turnDraft?: string;
  turnErrorCode?: string | null;
}>) {
  const running = ["requesting", "looking_up", "repairing", "committing"].includes(model.phase);
  const metricItems = [
    {kind: "economy" as const, label: "인구", value: value(model.population)},
    {kind: "economy" as const, label: "경제", value: "—"},
    {kind: "news" as const, label: "주요 사건", value: value(model.unacknowledgedMajorEventCount)},
    {kind: "action" as const, label: "대기 행동", value: value(model.queuedActionCount)},
    {kind: "wars" as const, label: "전쟁", value: value(model.ongoingWarCount)},
  ];
  return (
    <header className="game-hud" aria-label="게임 현황">
      <GameTooltip text="정치 화면 열기">
        <button type="button" className="game-player-badge" onClick={() => onOpen("politics")} aria-label={`${model.playerCountry.nameKo} 플레이 국가, 정치 열기`}>
          <span className="game-player-badge__color" style={{background: model.playerCountry.mapColor ?? "transparent"}} aria-hidden="true" />
          <span className="game-player-badge__name">{model.playerCountry.nameKo}</span>
          <span className="game-player-badge__code">{model.playerCountry.code}</span>
        </button>
      </GameTooltip>
      <div className="game-hud__metrics">
        {metricItems.map((item) => (
          <button type="button" key={item.label} onClick={() => onOpen(item.kind)} aria-label={`${item.label}: ${item.value}`}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </button>
        ))}
      </div>
      <div className="game-hud__clock">
        <div>
          <time dateTime={model.currentDate ?? undefined}>{model.currentDate ?? "—"}</time>
          <span>{model.turnNumber === null ? "턴 —" : `턴 ${model.turnNumber}`}</span>
        </div>
        <GameStatusBadge tone={model.phase === "failed" ? "error" : running ? "active" : "neutral"}>
          {phaseLabel[model.phase]}{turnErrorCode ? ` · ${turnErrorCode}` : ""}
        </GameStatusBadge>
        {running && <button type="button" className="game-hud__stop" onClick={onStop}>Stop</button>}
        {(model.phase === "failed" || model.phase === "cancelled") && onRetry && <button type="button" className="game-hud__retry" onClick={onRetry}>Retry</button>}
        {turnDraft && <p className="game-hud__draft" aria-live="polite" aria-label="진행 임시 초안">{turnDraft}</p>}
      </div>
    </header>
  );
}

