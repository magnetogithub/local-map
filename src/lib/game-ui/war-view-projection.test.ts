import {describe, expect, it} from "vitest";

import {createWarsProjection} from "./war-view-projection";

describe("13-18 production war projection", () => {
  it("uses a truthful unavailable state without injected wars", () => {
    expect(createWarsProjection()).toEqual({
      dataAvailable: false,
      unavailableReason: "전쟁 도메인 연결 예정",
      wars: [],
    });
  });
});
