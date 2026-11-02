import {describe, expect, it} from "vitest";

import {SimulationContractError} from "../simulation-contract-primitives";
import {targetDateForCustomInput} from "./turn-request";

describe("13-7 custom target date", () => {
  it.each([
    "2020-02-30",
    "2020-2-01",
    "01/02/2020",
    "not-a-date",
    "",
  ])("rejects invalid ISO input %j", (targetDate) => {
    expect(() => targetDateForCustomInput("2020-01-01", targetDate)).toThrowError(
      expect.objectContaining<Partial<SimulationContractError>>({code: "INVALID_DATE"}),
    );
  });

  it.each(["2019-12-31", "2020-01-01"])(
    "rejects a target at or before the current date: %s",
    (targetDate) => {
      expect(() => targetDateForCustomInput("2020-01-01", targetDate)).toThrowError(
        expect.objectContaining<Partial<SimulationContractError>>({code: "INVALID_TIME_ADVANCE"}),
      );
    },
  );

  it("accepts the 366-day contract boundary and rejects the next day", () => {
    expect(targetDateForCustomInput("2020-01-01", "2021-01-01")).toBe("2021-01-01");
    expect(() => targetDateForCustomInput("2020-01-01", "2021-01-02")).toThrowError(
      expect.objectContaining<Partial<SimulationContractError>>({code: "INVALID_TIME_ADVANCE"}),
    );
  });

  it("returns the canonical input unchanged regardless of locale", () => {
    const originalLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    expect(originalLocale).toEqual(expect.any(String));
    expect(targetDateForCustomInput("2020-02-28", "2020-02-29")).toBe("2020-02-29");
  });
});
