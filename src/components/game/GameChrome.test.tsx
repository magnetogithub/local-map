import {readFileSync} from "node:fs";

import {cleanup, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, describe, expect, it, vi} from "vitest";

import type {GameHudViewModel} from "@/lib/game-ui/contracts";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {GameEdgeNavigation, GAME_MENU_ITEMS} from "./GameEdgeNavigation";
import {GameHud} from "./GameHud";
import {GameEmptyState, GamePanel, GameStatusBadge, GameTooltipProvider} from "./GamePanel";
import {GameOverlayEscapeHandler} from "./GameOverlayEscapeHandler";

const gameCss = readFileSync("src/app/globals.css", "utf8");

const cssBlock = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = gameCss.match(new RegExp(`${escaped}\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS block: ${selector}`);
  return match[1];
};

const hud: GameHudViewModel = {
  dataAvailable: true,
  unavailableReason: null,
  playerCountry: {
    countryId: "KOR" as ActiveCountryId,
    nameKo: "대한민국",
    code: "KOR",
    flagUrl: null,
    mapColor: "#4f7f9f",
  },
  currentDate: "2020-01-01",
  turnNumber: 0,
  phase: "idle",
  population: null,
  unacknowledgedMajorEventCount: 2,
  queuedActionCount: 1,
  ongoingWarCount: null,
};

afterEach(cleanup);

describe("13-10 through 13-12 game chrome", () => {
  it("renders all eight keyboard-operable menu buttons and reports the active item", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<GameEdgeNavigation overlay={{kind: "economy"}} onToggle={onToggle}/>);
    expect(screen.getAllByRole("button")).toHaveLength(8);
    expect(GAME_MENU_ITEMS.map((item) => item.kind)).toEqual([
      "politics", "economy", "diplomacy", "wars", "action", "news", "save", "settings",
    ]);
    expect(screen.getByRole("button", {name: "경제"})).toHaveAttribute("aria-pressed", "true");
    const action = screen.getByRole("button", {name: "국가 행동"});
    action.focus();
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledWith("action");
  });

  it("renders hover and focus tooltips in the global layer and removes them on exit", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <GameTooltipProvider>
        <GameEdgeNavigation overlay={{kind: "economy"}} onToggle={onToggle}/>
        <GamePanel title="경제" onClose={vi.fn()}><p>overlay</p></GamePanel>
      </GameTooltipProvider>,
    );
    const politics = screen.getByRole("button", {name: "정치"});
    expect(politics).toHaveAccessibleName("정치");
    await user.hover(politics);
    const hoverTooltip = await screen.findByRole("tooltip");
    expect(hoverTooltip).toHaveTextContent("정치");
    expect(hoverTooltip.parentElement).toHaveClass("game-tooltip-layer");
    expect(screen.getByRole("complementary", {name: "경제"})).toBeVisible();
    await user.unhover(politics);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    politics.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("정치");
    politics.blur();
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    politics.focus();
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledWith("politics");
  });

  it("keeps Escape management-overlay close behavior", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<GameOverlayEscapeHandler onClose={onClose}/>);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders canonical HUD values and uses em dashes for unavailable metrics", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<GameHud model={hud} onOpen={onOpen} onStop={vi.fn()}/>);
    expect(screen.getByRole("button", {name: /대한민국 플레이 국가/})).toBeVisible();
    expect(screen.getByText("2020-01-01")).toBeVisible();
    expect(screen.getByText("턴 0")).toBeVisible();
    expect(screen.getByRole("button", {name: "인구: —"})).toBeVisible();
    expect(screen.getByRole("button", {name: "전쟁: —"})).toBeVisible();
    await user.click(screen.getByRole("button", {name: "주요 사건: 2"}));
    expect(onOpen).toHaveBeenCalledWith("news");
  });

  it("connects streaming draft, failure code and recovery controls to the HUD", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const onRetry = vi.fn();
    const {rerender} = render(<GameHud model={{...hud, phase: "looking_up"}} onOpen={vi.fn()} onStop={onStop} onRetry={onRetry} turnDraft="임시 세계 판정"/>);
    expect(screen.getByText("자료 확인 중")).toBeVisible();
    expect(screen.getByLabelText("진행 임시 초안")).toHaveTextContent("임시 세계 판정");
    await user.click(screen.getByRole("button", {name: "Stop"}));
    expect(onStop).toHaveBeenCalledOnce();

    rerender(<GameHud model={{...hud, phase: "failed"}} onOpen={vi.fn()} onStop={onStop} onRetry={onRetry} turnErrorCode="STALE_STATE"/>);
    expect(screen.getByText(/실패 · STALE_STATE/)).toBeVisible();
    await user.click(screen.getByRole("button", {name: "Retry"}));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("provides the shared panel, close control, empty state, and status badge", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <GamePanel title="정치" eyebrow="국가 관리" onClose={onClose}>
        <GameEmptyState title="정치 데이터 없음" description="데이터 연결 예정"/>
        <GameStatusBadge tone="warning">확인 필요</GameStatusBadge>
      </GamePanel>,
    );
    expect(screen.getByRole("complementary", {name: "정치"})).toBeVisible();
    expect(screen.getByText("정치 데이터 없음")).toBeVisible();
    expect(screen.getByText("확인 필요")).toHaveAttribute("data-tone", "warning");
    await user.click(screen.getByRole("button", {name: "정치 닫기"}));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("traps keyboard focus inside a management panel and restores its launcher", async () => {
    const user = userEvent.setup();
    const launcher = document.createElement("button");
    document.body.append(launcher);
    launcher.focus();
    const {unmount} = render(<GamePanel title="Panel" onClose={vi.fn()}><button type="button">Body action</button></GamePanel>);
    const close = screen.getByRole("button", {name: "Panel 닫기"});
    const bodyAction = screen.getByRole("button", {name: "Body action"});
    expect(close).toHaveFocus();
    await user.tab({shift: true});
    expect(bodyAction).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    unmount();
    expect(launcher).toHaveFocus();
    launcher.remove();
  });

  it("defines and consumes semantic tokens with the required layer order", () => {
    const tokens = [
      "surface", "surface-secondary", "surface-hover", "surface-selected",
      "text", "text-muted", "border", "accent", "accent-foreground",
      "danger", "danger-surface", "danger-foreground",
      "success", "success-surface", "success-foreground",
      "warning", "warning-surface", "warning-foreground",
      "tooltip-surface", "tooltip-foreground", "shadow",
      "transition-fast", "transition-panel",
    ];
    for (const token of tokens) {
      expect(gameCss).toContain(`--game-${token}:`);
      expect(gameCss.match(new RegExp(`var\\(--game-${token}\\)`, "g"))?.length ?? 0).toBeGreaterThan(0);
    }
    expect(cssBlock(".game-panel")).toContain("animation:game-panel-in var(--game-transition-panel)");
    expect(cssBlock(".game-tooltip-popup")).toContain("transition:opacity var(--game-transition-fast)");
    expect(cssBlock(".game-hud__stop")).toContain("var(--game-danger-surface)");
    expect(cssBlock('.game-status-badge[data-tone="active"]')).toContain("var(--game-success-surface)");
    expect(cssBlock('.game-status-badge[data-tone="warning"]')).toContain("var(--game-warning-surface)");
    expect(cssBlock('.game-status-badge[data-tone="error"]')).toContain("var(--game-danger-surface)");
    expect(cssBlock(".game-edge-nav__button[data-active]")).toContain("var(--game-accent)");

    const layer = (name: string) => Number(gameCss.match(new RegExp(`--z-${name}:(\\d+)`))?.[1]);
    expect([
      layer("map"), layer("map-ui"), layer("hud"), layer("edge-nav"),
      layer("overlay"), layer("toast"), layer("major-modal"), layer("fatal"),
    ]).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(cssBlock(".game-tooltip-layer")).toContain("z-index:var(--z-toast)");
  });

  it("leaves no direct state colors in the repaired component selectors", () => {
    const selectors = [
      ".game-player-badge__color",
      ".game-hud__metrics button:hover",
      ".game-hud__stop",
      ".game-status-badge",
      '.game-status-badge[data-tone="active"]',
      '.game-status-badge[data-tone="warning"]',
      '.game-status-badge[data-tone="error"]',
      ".game-edge-nav__button:hover",
      ".game-edge-nav__button[data-active]",
      ".game-panel__titlebar",
      ".game-panel__close:hover",
      ".game-empty-state__mark",
      ".game-tooltip-popup",
    ];
    for (const selector of selectors) {
      expect(cssBlock(selector), selector).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    }
    expect(gameCss.match(/\b(?:120|160)ms\b/g)).toEqual(["120ms", "160ms"]);
    expect(cssBlock('.game-screen[data-reduce-motion] .game-panel,.game-screen[data-reduce-motion] .game-tooltip-popup'))
      .toContain("animation:none;transition:none");
    expect(gameCss).toMatch(/prefers-reduced-motion:reduce[^}]*\}\s*\.game-tooltip-popup\{transition:none\}/);
  });
});

