import {GameTooltip} from "./GamePanel";
import type {GameMenuOverlayKind, GameOverlay} from "@/lib/game-ui/overlay-reducer";

export const GAME_MENU_ITEMS: readonly Readonly<{
  kind: GameMenuOverlayKind;
  label: string;
  glyph: string;
}>[] = Object.freeze([
  {kind: "politics", label: "정치", glyph: "政"},
  {kind: "economy", label: "경제", glyph: "₩"},
  {kind: "diplomacy", label: "외교", glyph: "交"},
  {kind: "wars", label: "전쟁", glyph: "⚑"},
  {kind: "action", label: "국가 행동", glyph: "行"},
  {kind: "news", label: "뉴스", glyph: "報"},
  {kind: "save", label: "저장", glyph: "存"},
  {kind: "settings", label: "설정", glyph: "⚙"},
]);

export function GameEdgeNavigation({
  overlay,
  onToggle,
}: Readonly<{
  overlay: GameOverlay;
  onToggle(kind: GameMenuOverlayKind): void;
}>) {
  return (
    <nav className="game-edge-nav" aria-label="게임 관리 메뉴">
      {GAME_MENU_ITEMS.map((item) => {
        const active = overlay.kind === item.kind;
        return (
          <GameTooltip text={item.label} placement="right" key={item.kind}>
            <button
              type="button"
              className="game-edge-nav__button"
              data-menu-kind={item.kind}
              data-active={active || undefined}
              aria-pressed={active}
              aria-label={item.label}
              onClick={() => onToggle(item.kind)}
            >
              <span className="game-edge-nav__glyph" aria-hidden="true">{item.glyph}</span>
              <span>{item.label}</span>
            </button>
          </GameTooltip>
        );
      })}
    </nav>
  );
}

