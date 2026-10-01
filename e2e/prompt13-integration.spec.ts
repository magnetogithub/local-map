import {expect, test, type Locator, type Page} from "@playwright/test";

const ndjson = (turnId: string, resolution: unknown) => [
  {version: 1, turnId, sequence: 0, type: "turn.started"},
  {version: 1, turnId, sequence: 1, type: "phase.changed", phase: "requesting"},
  {version: 1, turnId, sequence: 2, type: "draft.delta", delta: "Deterministic fixture resolution"},
  {version: 1, turnId, sequence: 3, type: "resolution.ready", resolution},
].map((event) => JSON.stringify(event)).join("\n") + "\n";

async function expectInsideViewport(locator: Locator, viewport: Readonly<{width: number; height: number}>) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

async function installFixtureTurn(page: Page) {
  let requestCount = 0;
  await page.route("**/api/simulation/turn", async (route) => {
    requestCount += 1;
    const body = route.request().postDataJSON() as {turnId: string; context: {revisions: {simulation: number; world: number}; period: {startDate: string; endDate: string}; queuedActions: {actionId: string}[]}};
    const actionId = body.context.queuedActions[0]?.actionId;
    const endDate = body.context.period.endDate;
    const events = [
      {eventId: "event.local-debate", date: endDate, title: "Local Debate", publicNarrative: "A domestic debate remains non-blocking.", actorCountryIds: ["FRA"], relatedFactIds: [], relatedSituationIds: [], causes: [{kind: "queued-action", id: actionId}], outcomeCategory: "domestic", significance: "minor"},
      {eventId: "event.border-accord", date: endDate, title: "Border Accord", publicNarrative: "France adopts a new constitutional name after the accord.", actorCountryIds: ["FRA", "DEU"], relatedFactIds: [], relatedSituationIds: [], causes: [{kind: "queued-action", id: actionId}], outcomeCategory: "territorial", significance: "major"},
      {eventId: "event.european-charter", date: endDate, title: "European Charter", publicNarrative: "A transformative European charter is announced.", actorCountryIds: ["FRA", "DEU"], relatedFactIds: [], relatedSituationIds: [], causes: [{kind: "queued-action", id: actionId}], outcomeCategory: "treaty", significance: "transformative"},
    ];
    const resolution = {
      contractVersion: "turn-resolution.v1",
      baseSimulationRevision: body.context.revisions.simulation,
      baseWorldRevision: body.context.revisions.world,
      period: body.context.period,
      playerActionOutcomes: [{outcomeId: "outcome.fixture", actionId, status: "succeeded", evidenceEventId: "event.border-accord", summary: "The proposal was adopted.", remainingConditions: []}],
      events,
      factMutations: [],
      situationMutations: [],
      scheduledConsequences: [],
      worldEffects: [{effectId: "effect.rename-france", type: "country.renamed", causedByEventId: "event.border-accord", countryId: "FRA", displayName: "French Republic 2020"}],
      advisorSummary: "The accord changed the map record and produced two major notices.",
      unresolvedQuestions: ["Implementation talks continue."],
    };
    await route.fulfill({status: 200, contentType: "application/x-ndjson", body: ndjson(body.turnId, resolution)});
  });
  return () => requestCount;
}

async function enterGame(page: Page) {
  await page.goto("/");
  await expect(page.locator(".map-status")).toBeHidden({timeout: 90_000});
  await page.locator("#country-search").fill("FRA");
  await page.locator(".results .result").first().click();
  await page.locator(".confirm").click();
  await expect(page).toHaveURL(/\/game$/, {timeout: 30_000});
  await expect(page.getByTestId("game-screen")).toBeVisible();
  await expect(page.locator(".map-status")).toBeHidden({timeout: 90_000});
}

const runtimeSourceIds = ["countries-low", "countries-high", "borders-low", "borders-high"] as const;

async function expectHealthyMap(page: Page, expectedFranceName?: string) {
  await expect(page.locator(".map-status")).toBeHidden({timeout: 90_000});
  await expect(page.getByText("지도 데이터를 불러오지 못했습니다", {exact: false})).toHaveCount(0);
  await expect.poll(async () => page.evaluate(async (sourceIds) => {
    const debug = window.__PAX_MAP_DEBUG__;
    if (!debug?.getWorldRevision || !debug.getMapProjectionRevision || !debug.getMapSourceSyncSnapshot || !debug.getMapSourceFeatures) return false;
    const worldRevision = debug.getWorldRevision();
    const snapshot = debug.getMapSourceSyncSnapshot();
    const features = await Promise.all(sourceIds.map(id => debug.getMapSourceFeatures!(id)));
    return debug.getMapProjectionRevision() === worldRevision && snapshot.revision === worldRevision &&
      !snapshot.resyncRequired && !snapshot.error && sourceIds.every((id, index) =>
        snapshot.sources[id]?.revision === worldRevision && features[index].length > 0
      ) && (debug.queryRenderedCountryIds().length > 0 || features[0].length > 0);
  }, runtimeSourceIds), {timeout: 90_000}).toBe(true);
  const state = await page.evaluate(async (sourceIds) => {
    const debug = window.__PAX_MAP_DEBUG__!;
    const features = await Promise.all(sourceIds.map(id => debug.getMapSourceFeatures!(id)));
    return {
      worldRevision: debug.getWorldRevision!(),
      projectionRevision: debug.getMapProjectionRevision!(),
      snapshot: debug.getMapSourceSyncSnapshot!(),
      franceNames: features.slice(0, 2).map(items => items.find(feature => feature.ownerCountryId === "FRA")?.displayName),
      featureCounts: features.map(items => items.length),
    };
  }, runtimeSourceIds);
  expect(state.snapshot).toMatchObject({revision: state.worldRevision, resyncRequired: false, error: null});
  expect(state.projectionRevision).toBe(state.worldRevision);
  expect(state.featureCounts.every(count => count > 0)).toBe(true);
  if (expectedFranceName) expect(state.franceNames).toEqual([expectedFranceName, expectedFranceName]);
  return state;
}

for (const viewport of [{width: 1280, height: 720}, {width: 1920, height: 1080}]) {
  test(`13-29 through 13-33 deterministic integration ${viewport.width}x${viewport.height}`, async ({page}) => {
    test.setTimeout(300_000);
    await page.setViewportSize(viewport);
    const runtimeMapErrors: string[] = [];
    page.on("console", message => {
      const text = message.text();
      if (message.type() === "error" &&
          (/Map source incremental synchronization failed|Map source verification failed|MapLibre error/i.test(text)) &&
          !/ReadPixels|NO_COLOR|FORCE_COLOR/i.test(text)) runtimeMapErrors.push(text);
    });
    const requestCount = await installFixtureTurn(page);
    await enterGame(page);
    await page.evaluate(() => {
      const debug = window.__PAX_MAP_DEBUG__;
      if (debug) debug.jumpTo(debug.getCenter(), 3);
    });
    const initialMap = await expectHealthyMap(page);
    const initialFranceName = initialMap.franceNames[0]!;

    await expect(page.getByTestId("world-map")).toHaveCSS("width", `${viewport.width}px`);
    await expect(page.locator(".game-player-badge")).toBeVisible();
    await expect(page.locator(".game-hud__clock time")).toHaveText("2020-01-01");
    await expect(page.locator(".game-edge-nav__button")).toHaveCount(8);
    await expect(page.getByTestId("map-country-picker")).toBeVisible();
    expect(await page.evaluate(() => ({areas: window.__PAX_MAP_DEBUG__?.hasLayer("war-areas"), fronts: window.__PAX_MAP_DEBUG__?.hasLayer("war-fronts")}))).toEqual({areas: true, fronts: true});

    const initialSourceState = await page.evaluate(() => window.__PAX_MAP_DEBUG__?.getMapSourceSyncSnapshot?.());
    const initialSourceIdentities = await page.evaluate(sourceIds => sourceIds.map(id => window.__PAX_MAP_DEBUG__?.getMapSourceIdentity?.(id)), runtimeSourceIds);
    await page.locator('[data-menu-kind="settings"]').click();
    await page.locator('[data-setting-key="showCountryLabels"]').uncheck();
    await page.locator('[data-setting-key="showCapitalMarkers"]').uncheck();
    await page.locator('[data-setting-key="emphasizeBorders"]').check();
    expect(await page.evaluate(() => window.__PAX_MAP_DEBUG__?.getMapSourceSyncSnapshot?.())).toEqual(initialSourceState);
    expect(await page.evaluate(sourceIds => sourceIds.map(id => window.__PAX_MAP_DEBUG__?.getMapSourceIdentity?.(id)), runtimeSourceIds)).toEqual(initialSourceIdentities);
    await page.keyboard.press("Escape");

    const politics = page.locator('[data-menu-kind="politics"]');
    await politics.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("politics-overlay")).toBeVisible();
    await page.locator('[data-menu-kind="economy"]').click();
    await expect(page.getByTestId("economy-overlay")).toBeVisible();
    await expect(page.getByTestId("politics-overlay")).toHaveCount(0);

    const picker = page.getByTestId("map-country-picker");
    await picker.selectOption("DEU");
    await expect(page.getByTestId("country-overlay")).toBeVisible();
    await expect(page.locator(".game-relationship-direction")).toHaveCount(2);
    await page.getByTestId("country-overlay").locator(".game-primary-action").click();
    await expect(page.getByTestId("diplomacy-overlay")).toBeVisible();
    await expect(page.getByTestId("diplomacy-overlay").locator("button").last()).toBeDisabled();

    await page.locator('[data-menu-kind="action"]').click();
    const actionPanel = page.getByTestId("game-panel");
    await expectInsideViewport(actionPanel, viewport);
    await page.locator("#game-player-action").fill("Propose a constitutional accord");
    await page.locator("#game-player-action").press("Enter");
    await expect(page.locator(".action-queue")).toContainText("Propose a constitutional accord");
    await page.locator(".game-custom-date input").fill("2020-01-10");
    await page.locator(".game-advance-submit").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({timeout: 30_000});
    const committedMap = await expectHealthyMap(page, "French Republic 2020");
    expect(committedMap.worldRevision).toBe(initialMap.worldRevision + 1);
    await expect(dialog).toContainText("1 / 2");
    await expect(page.locator(".game-advance-submit")).toBeDisabled();
    await expectInsideViewport(dialog, viewport);
    await expectInsideViewport(dialog.getByRole("button", {name: "확인"}), viewport);
    await page.screenshot({path: `screenshots/prompt13-32-modal-${viewport.width}x${viewport.height}.png`, fullPage: true});

    await dialog.getByRole("button", {name: "확인"}).click();
    await expect(dialog).toContainText("2 / 2");
    await dialog.getByRole("button", {name: "확인"}).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("news-overlay")).toBeVisible();
    await expectHealthyMap(page, "French Republic 2020");
    await page.locator(".game-news__list button").filter({hasText: "Border Accord"}).click();
    await expect(page.locator(".game-news__detail")).toContainText("지도에 반영됨");
    await expect(page.locator(".game-turn-result")).toContainText("Implementation talks continue.");
    await page.locator(".game-news__countries button").filter({hasText: "DEU"}).click();
    await expect(page.getByTestId("country-overlay")).toBeVisible();
    await expectHealthyMap(page, "French Republic 2020");
    await page.waitForTimeout(250);
    await page.screenshot({path: `screenshots/prompt13-32-overlay-${viewport.width}x${viewport.height}.png`, fullPage: true});

    await page.locator('[data-menu-kind="action"]').click();
    await page.locator(".turn-undo").click();
    await expect(page.locator(".game-hud__clock time")).toHaveText("2020-01-01");
    const undoneMap = await expectHealthyMap(page, initialFranceName);
    expect(undoneMap.worldRevision).toBe(committedMap.worldRevision + 1);
    await page.locator(".turn-redo").click();
    await expect(page.locator(".game-hud__clock time")).toHaveText("2020-01-10");
    await expect(page.getByTestId("map-country-picker").locator('option[value="FRA"]')).toContainText("French Republic 2020");
    const redoneMap = await expectHealthyMap(page, "French Republic 2020");
    expect(redoneMap.worldRevision).toBe(undoneMap.worldRevision + 1);

    await page.locator('[data-menu-kind="save"]').click();
    await page.getByTestId("save-overlay").locator(".game-primary-action").click();
    await expect(page.getByTestId("save-overlay").getByRole("status")).toContainText("저장되지 않았습니다");
    expect(requestCount()).toBe(1);
    expect(runtimeMapErrors).toEqual([]);
    await page.screenshot({path: `screenshots/prompt13-32-hud-map-${viewport.width}x${viewport.height}.png`, fullPage: true});

    await page.reload();
    await expect(page).toHaveURL(/\/$/, {timeout: 30_000});
    expect(await page.evaluate(() => localStorage.getItem("pax-local:game-setup:v1"))).toBeNull();
  });
}
