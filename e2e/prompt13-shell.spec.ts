import {expect, test, type Locator, type Page} from "@playwright/test";

async function enterGame(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status").first()).toBeHidden({timeout: 90_000});
  await page.getByLabel("국가 검색").fill("FRA");
  await page.getByRole("option", {name: /FRA/}).click();
  await page.getByRole("button", {name: /프랑스.*플레이 국가/}).click();
  await expect(page).toHaveURL(/\/game$/, {timeout: 30_000});
  await expect(page.getByTestId("game-screen")).toBeVisible();
  await expect(page.locator(".game-player-badge")).toContainText("프랑스");
  await expect(page.locator(".game-edge-nav__button")).toHaveCount(8);
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect(page.getByRole("status").first()).toBeHidden({timeout: 90_000});
}

async function expectInsideViewport(locator: Locator, size: Readonly<{width: number; height: number}>) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
}

for (const size of [{width: 1280, height: 720}, {width: 1920, height: 1080}]) {
  test(`13-13 full-screen game shell ${size.width}x${size.height}`, async ({page}) => {
    await page.setViewportSize(size);
    await enterGame(page);

    const mapBox = await page.getByTestId("world-map").boundingBox();
    expect(mapBox).toMatchObject({x: 0, y: 0, width: size.width, height: size.height});
    for (const button of await page.locator(".game-edge-nav__button").all()) {
      await expectInsideViewport(button, size);
    }
    await page.screenshot({
      path: `screenshots/prompt13-13-shell-entry-${size.width}x${size.height}.png`,
      fullPage: true,
    });

    const economyButton = page.getByRole("button", {name: "경제", exact: true});
    await economyButton.click();
    const economyPanel = page.getByRole("complementary", {name: "경제"});
    await expect(economyPanel).toBeVisible();
    await expect(economyButton).toHaveAttribute("aria-pressed", "true");
    await expectInsideViewport(economyPanel, size);
    await expect(page.locator(".game-panel__body")).toHaveCSS("overflow-y", "auto");

    const layerOrder = await page.locator(".app-shell[data-page-mode='game']").evaluate((shell) => {
      const rootStyle = getComputedStyle(shell);
      const layer = document.querySelector<HTMLElement>(".game-tooltip-layer");
      const panel = document.querySelector<HTMLElement>(".game-panel");
      return {
        overlay: Number(rootStyle.getPropertyValue("--z-overlay")),
        toast: Number(rootStyle.getPropertyValue("--z-toast")),
        major: Number(rootStyle.getPropertyValue("--z-major-modal")),
        panel: Number(panel ? getComputedStyle(panel).zIndex : Number.NaN),
        tooltip: Number(layer ? getComputedStyle(layer).zIndex : Number.NaN),
      };
    });
    expect(layerOrder).toEqual({overlay: 40, toast: 50, major: 60, panel: 40, tooltip: 50});
    expect(layerOrder.overlay).toBeLessThan(layerOrder.toast);
    expect(layerOrder.toast).toBeLessThan(layerOrder.major);
    await page.screenshot({
      path: `screenshots/prompt13-13-shell-repair-${size.width}x${size.height}.png`,
      fullPage: true,
    });

    const playerBadge = page.locator(".game-player-badge");
    await playerBadge.hover();
    let tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText("정치 화면 열기");
    await expectInsideViewport(tooltip, size);
    await page.screenshot({
      path: `screenshots/prompt13-13-hud-tooltip-${size.width}x${size.height}.png`,
      fullPage: true,
    });
    await page.mouse.move(size.width / 2, size.height - 24);
    await expect(tooltip).toBeHidden();

    const politicsButton = page.getByRole("button", {name: "정치", exact: true});
    await politicsButton.hover();
    tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText("정치");
    await expectInsideViewport(tooltip, size);
    await page.screenshot({
      path: `screenshots/prompt13-13-tooltip-${size.width}x${size.height}.png`,
      fullPage: true,
    });
    await page.mouse.move(size.width / 2, size.height - 24);
    await expect(tooltip).toBeHidden();

    await politicsButton.focus();
    await expect(page.getByRole("tooltip")).toHaveText("정치");
    await politicsButton.press("Enter");
    await expect(page.getByRole("complementary", {name: "정치"})).toBeVisible();
    await expect(politicsButton).toHaveAttribute("aria-pressed", "true");
    await politicsButton.press("Enter");
    await expect(page.getByRole("complementary")).toBeHidden();

    await economyButton.click();
    await expect(economyPanel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(economyPanel).toBeHidden();

    const actionButton = page.getByRole("button", {name: "국가 행동", exact: true});
    await actionButton.click();
    const actionPanel = page.getByRole("complementary", {name: "국가 행동"});
    await expect(actionPanel).toBeVisible();
    const startAdvance = page.getByRole("button", {name: "진행 시작"});
    await expect(startAdvance).toBeDisabled();
    await page.getByRole("checkbox", {name: "행동 없이 시간만 진행"}).check();
    await page.getByRole("button", {name: "1주"}).click();
    await expect(startAdvance).toBeEnabled();
    await page.getByLabel("목표 날짜 직접 입력").fill("2020-01-01");
    await expect(page.locator(".game-field-message[role='alert']")).toContainText("현재 날짜보다 뒤인 유효한 ISO 날짜");
    await expect(startAdvance).toBeDisabled();
    await expect(page.locator(".game-panel__body")).toHaveCSS("overflow-y", "auto");
    await page.screenshot({
      path: `screenshots/prompt13-23-action-${size.width}x${size.height}.png`,
      fullPage: true,
    });
  });
}
