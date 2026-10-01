import {cleanup, render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, describe, expect, it, vi} from "vitest";

import type {ActiveCountryId} from "@/lib/world/country-id";
import {MapCountryPicker} from "./MapCountryPicker";

afterEach(cleanup);

describe("13-29 keyboard map-country selection", () => {
  it("selects an active foreign country using only the keyboard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MapCountryPicker
      selectedCountryId={null}
      options={[
        {countryId: "AAA" as ActiveCountryId, name: "Alpha", role: "player"},
        {countryId: "BBB" as ActiveCountryId, name: "Beta", role: "foreign"},
      ]}
      onSelect={onSelect}
    />);
    const picker = screen.getByRole("combobox", {name: "지도 국가 선택"});
    picker.focus();
    await user.selectOptions(picker, "BBB");
    expect(onSelect).toHaveBeenCalledWith("BBB");
  });

  it("cannot expose a retired country that is absent from active options", () => {
    render(<MapCountryPicker
      selectedCountryId={null}
      options={[{countryId: "AAA" as ActiveCountryId, name: "Alpha", role: "player"}]}
      onSelect={vi.fn()}
    />);
    expect(screen.queryByRole("option", {name: /BBB/})).not.toBeInTheDocument();
  });
});
