import {expect, test} from "./catalog-fixture";

const ndjson = (turnId: string, resolution: unknown, draft = "판정 중") => [
  {version: 1, turnId, sequence: 0, type: "turn.started"},
  {version: 1, turnId, sequence: 1, type: "phase.changed", phase: "requesting"},
  {version: 1, turnId, sequence: 2, type: "draft.delta", delta: draft},
  {version: 1, turnId, sequence: 3, type: "resolution.ready", resolution},
].map((event) => JSON.stringify(event)).join("\n") + "\n";

function createResponseGate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {wait, release};
}

test("queues, adjudicates, unifies, links the report, undoes, and stops atomically", async ({page}) => {
  test.setTimeout(300_000);
  const firstTurnResponseGate = createResponseGate();
  const cancelledTurnResponseGate = createResponseGate();
  let firstTurnRequestArrived = false;
  let cancelledTurnRequestArrived = false;
  let retryAllowed=false,retryTarget='',retryRequestArrived=false;
  await page.route("**/api/simulation/turn", async (route) => {
    const body = route.request().postDataJSON() as {turnId: string; context: {revisions: {simulation: number; world: number}; period: {startDate: string; endDate: string}; queuedActions: {actionId: string}[]; countryDirectory: {countryId: string}[]; subdivisions: {parentCountryId: string}[]}};
    if (body.context.revisions.simulation < 2) {
      expect(body.context.countryDirectory.map((country) => country.countryId)).toEqual(expect.arrayContaining(["AUT", "DEU"]));
      expect(body.context.subdivisions.every(entry=>entry.parentCountryId === "AUT")).toBe(true);
      expect(body.context.subdivisions.length).toBeGreaterThan(0);
    }
    if (body.context.revisions.simulation >= 2) {
      if(retryAllowed){retryRequestArrived=true;expect(body.context.period.endDate).toBe(retryTarget);
        await route.fulfill({status:200,contentType:'application/x-ndjson',body:ndjson(body.turnId,{contractVersion:'turn-resolution.v1',baseSimulationRevision:body.context.revisions.simulation,baseWorldRevision:body.context.revisions.world,period:body.context.period,playerActionOutcomes:[],events:[],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[],advisorSummary:'Retried narrative turn',unresolvedQuestions:[]})});return;}
      retryTarget=body.context.period.endDate;
      cancelledTurnRequestArrived = true;
      await cancelledTurnResponseGate.wait;
      await route.fulfill({status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({version: 1, turnId: body.turnId, sequence: 0, type: "turn.started"})}\n`}).catch(() => undefined);
      return;
    }
    const first = body.context.revisions.simulation === 0;
    const actionId = body.context.queuedActions[0]?.actionId;
    const resolution = first ? {
      contractVersion: "turn-resolution.v1",
      baseSimulationRevision: body.context.revisions.simulation,
      baseWorldRevision: body.context.revisions.world,
      period: body.context.period,
      playerActionOutcomes: [{outcomeId: "outcome.negotiation", actionId, status: "delayed", evidenceEventId: "event.negotiation", summary: "통일 협상이 시작됐지만 즉시 통합되지는 않았습니다.", remainingConditions: ["양국 의회의 비준이 필요합니다."]}],
      events: [{eventId: "event.negotiation", date: body.context.period.endDate, title: "통일 협상 개시", publicNarrative: "오스트리아와 독일 대표단이 통일 협상을 시작했습니다.", actorCountryIds: ["AUT", "DEU"], relatedFactIds: ["fact.negotiation"], relatedSituationIds: ["situation.negotiation"], causes: [{kind: "queued-action", id: actionId}], outcomeCategory: "diplomatic", significance: "notable"}],
      factMutations: [{mutationId: "mutation.fact", operation: "upsert", causedByEventId: "event.negotiation", factId: null, fact: {factId: "fact.negotiation", kind: "treaty-or-negotiation", actorCountryIds: ["AUT", "DEU"], publicSummary: "양국의 통일 협상이 진행 중입니다.", startDate: body.context.period.endDate, status: "active", sourceEventId: "event.negotiation"}}],
      situationMutations: [{mutationId: "mutation.situation", operation: "upsert", causedByEventId: "event.negotiation", situationId: null, situation: {situationId: "situation.negotiation", type: "unification-negotiation", participantCountryIds: ["AUT", "DEU"], stage: "협상 개시", stakes: "정치 제도 통합", startedByEventId: "event.negotiation", lastUpdatedByEventId: "event.negotiation", unresolvedQuestion: "양국 의회가 비준할 것인가?", status: "active"}}],
      scheduledConsequences: [], worldEffects: [], advisorSummary: "협상은 시작됐지만 현재 국경 변화는 없습니다.", unresolvedQuestions: ["조약 비준 여부가 남아 있습니다."],
    } : {
      contractVersion: "turn-resolution.v1",
      baseSimulationRevision: body.context.revisions.simulation,
      baseWorldRevision: body.context.revisions.world,
      period: body.context.period,
      playerActionOutcomes: [],
      events: [{eventId: "event.ratification", date: body.context.period.endDate, title: "통일 조약 비준", publicNarrative: "양국 의회가 통일 조약을 비준하고 공동 연방을 출범시켰습니다.", actorCountryIds: ["AUT", "DEU"], relatedFactIds: ["fact.negotiation"], relatedSituationIds: ["situation.negotiation"], causes: [{kind: "authoritative-event", id: "event.negotiation"}], outcomeCategory: "treaty", significance: "transformative"}],
      factMutations: [{mutationId: "mutation.fact.end", operation: "end", causedByEventId: "event.ratification", factId: "fact.negotiation", fact: null}],
      situationMutations: [{mutationId: "mutation.situation.resolve", operation: "resolve", causedByEventId: "event.ratification", situationId: "situation.negotiation", situation: null}],
      scheduledConsequences: [], worldEffects: [{effectId: "effect.unification", type: "countries.unified", causedByEventId: "event.ratification", countryIds: ["AUT", "DEU"], newCountryRef: "country.federation", displayName: "중부 유럽 연방"}], advisorSummary: "조약 비준으로 양국이 공동 연방으로 통합되었습니다.", unresolvedQuestions: [],
    };
    if (first) {
      firstTurnRequestArrived = true;
      await firstTurnResponseGate.wait;
    }
    await route.fulfill({status: 200, contentType: "application/x-ndjson", body: ndjson(body.turnId, resolution)});
  });

  try {
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto("/");
  await expect(page.getByRole("status").first()).toBeHidden({timeout: 90_000});
  await page.getByLabel("국가 검색").fill("AUT");
  await page.getByRole("option", {name: /AUT/}).click();
  await page.getByRole("button", {name: /오스트리아.*플레이 국가/}).click();
  await expect(page).toHaveURL(/\/game$/, {timeout: 30_000});
  await page.locator('[data-menu-kind="action"]').click();

  const initialRevision = await page.locator(".app-shell").getAttribute("data-world-revision");
  const composer = page.getByLabel("현재 플레이 국가가 시도할 행동");
  await composer.fill("독일과 통일 협상을 시작한다");
  await composer.press("Enter");
  await expect(page.getByText("독일과 통일 협상을 시작한다", {exact: true})).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-world-revision", initialRevision ?? "0");

  await page.getByRole("button", {name: "1개월"}).click();
  await page.locator(".game-advance-submit").click();
  await expect.poll(() => firstTurnRequestArrived).toBe(true);
  await expect(page.locator(".game-hud__stop")).toBeVisible();
  await expect(page.locator(".turn-status")).toHaveAttribute("data-phase", "requesting");
  firstTurnResponseGate.release();
  await expect(page.locator(".game-action-result")).toBeVisible({timeout: 30_000});
  await expect(page.locator(".app-shell")).toHaveAttribute("data-world-revision", initialRevision ?? "0");

  await page.locator(".game-time-only-confirm input").check();
  await page.getByRole("button", {name: "1개월"}).click();
  await page.locator(".game-advance-submit").click();
  const majorEvent = page.getByRole("dialog");
  await expect(majorEvent).toBeVisible({timeout: 30_000});
  await expect.poll(async () => Number(await page.locator(".app-shell").getAttribute("data-world-revision"))).toBe(Number(initialRevision) + 1);
  await majorEvent.getByRole("button", {name: "확인"}).click();
  await expect(page.getByTestId("news-overlay")).toBeVisible();
  await expect(page.locator(".game-news__list")).toContainText("통일 조약 비준");
  await expect(page.locator(".game-turn-result")).toContainText("통합이 지도에 반영");

  await page.locator('[data-menu-kind="action"]').click();
  await page.getByRole("button", {name: "마지막 턴 되돌리기"}).click();
  await expect.poll(async () => Number(await page.locator(".app-shell").getAttribute("data-world-revision"))).toBe(Number(initialRevision) + 2);
  await expect(page.locator(".game-action-result")).toHaveCount(0);

  await page.getByRole("button", {name: "다시 실행"}).click();
  await expect.poll(async () => Number(await page.locator(".app-shell").getAttribute("data-world-revision"))).toBe(Number(initialRevision) + 3);
  expect(await page.evaluate(() => localStorage.getItem("pax-local:game-setup:v1"))).toBeNull();

  const dateBeforeStop = await page.locator(".simulation-heading time").textContent();
  const revisionBeforeStop = await page.locator(".app-shell").getAttribute("data-world-revision");
  await page.locator(".game-time-only-confirm input").check();
  await page.getByRole("button", {name: "1일"}).click();
  await page.locator(".game-advance-submit").click();
  await expect.poll(() => cancelledTurnRequestArrived).toBe(true);
  await expect(page.locator(".game-hud__stop")).toBeVisible();
  await expect(page.locator(".turn-status")).toHaveAttribute("data-phase", "requesting");
  await page.locator(".game-hud__stop").click();
  cancelledTurnResponseGate.release();
  await expect(page.locator(".turn-status")).toHaveAttribute("data-phase", "cancelled");
  await expect(page.locator(".simulation-heading time")).toHaveText(dateBeforeStop ?? "");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-world-revision", revisionBeforeStop ?? "");
  retryAllowed=true;await page.locator('.turn-status').getByRole('button',{name:'Retry',exact:true}).click();
  await expect.poll(()=>retryRequestArrived).toBe(true);await expect(page.locator('.turn-status')).toHaveAttribute('data-phase','committed',{timeout:30000});
  await expect(page.locator('.simulation-heading time')).toHaveText(retryTarget);await expect(page.locator('.app-shell')).toHaveAttribute('data-world-revision',revisionBeforeStop??'');

  await page.reload();
  await expect(page.getByRole("status").first()).toBeHidden({timeout: 90_000});
  await expect(page.locator(".app-shell")).toHaveAttribute("data-world-revision", initialRevision ?? "0");
  await expect(page.locator(".simulation-heading")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("pax-local:game-setup:v1"))).toBeNull();
  await expect.poll(() => page.evaluate(async () =>
    (await indexedDB.databases()).some((database) => database.name === "pax-local-runtime"),
  )).toBe(false);
  } finally {
    firstTurnResponseGate.release();
    cancelledTurnResponseGate.release();
    await page.unrouteAll({behavior: "wait"}).catch(() => undefined);
  }
});

test("sends production CHN and USA subdivision summaries and resets the player lifecycle", async ({page}) => {
  test.setTimeout(300_000);
  const observed = new Map<string, number>();
  await page.route("**/api/simulation/turn", async (route) => {
    const body = route.request().postDataJSON() as {turnId: string; context: {playerCountry: {countryId: string}; revisions: {simulation: number; world: number}; period: {startDate: string; endDate: string}; countryDirectory: {countryId: string}[]; subdivisions: {parentCountryId: string}[]}};
    const player = body.context.playerCountry.countryId;
    expect(body.context.countryDirectory.map((country) => country.countryId)).toEqual(expect.arrayContaining(["CHN", "USA"]));
    observed.set(player, body.context.subdivisions.filter((entry) => entry.parentCountryId === player).length);
    const resolution = {
      contractVersion: "turn-resolution.v1",
      baseSimulationRevision: body.context.revisions.simulation,
      baseWorldRevision: body.context.revisions.world,
      period: body.context.period,
      playerActionOutcomes: [], events: [], factMutations: [], situationMutations: [],
      scheduledConsequences: [], worldEffects: [], advisorSummary: "시간이 경과했습니다.", unresolvedQuestions: [],
    };
    await route.fulfill({status: 200, contentType: "application/x-ndjson", body: ndjson(body.turnId, resolution)});
  });

  await page.setViewportSize({width: 1440, height: 900});
  await page.goto("/");
  await expect(page.getByRole("status").first()).toBeHidden({timeout: 90_000});
  const choose = async (countryId: "CHN" | "USA") => {
    await page.goto("/");
    await expect(page.locator(".map-status")).toBeHidden({timeout: 90_000});
    await page.getByLabel("국가 검색").fill(countryId);
    await page.getByRole("option", {name: new RegExp(countryId)}).click();
    await page.getByRole("button", {name: /플레이 국가로/}).click();
    await expect(page).toHaveURL(/\/game$/, {timeout: 30_000});
    await page.locator('[data-menu-kind="action"]').click();
    await expect(page.locator(".simulation-heading")).toBeVisible();
  };
  await choose("CHN");
  await page.locator(".game-time-only-confirm input").check();
  await page.getByRole("button", {name: "1개월"}).click();
  await page.locator(".game-advance-submit").click();
  await expect.poll(() => observed.get("CHN")).toBe(32);

  await choose("USA");
  await expect(page.locator(".simulation-heading time")).toHaveText("2020-01-01");
  await page.locator(".game-time-only-confirm input").check();
  await page.getByRole("button", {name: "1개월"}).click();
  await page.locator(".game-advance-submit").click();
  await expect.poll(() => observed.get("USA")).toBe(52);
});
