import type {ActiveCountryId} from "@/lib/world/country-id";

export type MapCountryPickerOption = Readonly<{
  countryId: ActiveCountryId;
  name: string;
  role: "player" | "foreign";
}>;

export function MapCountryPicker({options, selectedCountryId, onSelect}: Readonly<{
  options: readonly MapCountryPickerOption[];
  selectedCountryId: ActiveCountryId | null;
  onSelect(countryId: ActiveCountryId): void;
}>) {
  return <label className="game-map-country-picker">
    <span>지도 국가 선택</span>
    <select
      data-testid="map-country-picker"
      value={selectedCountryId ?? ""}
      onChange={(event) => {
        const option = options.find((entry) => entry.countryId === event.target.value);
        if (option) onSelect(option.countryId);
      }}
    >
      <option value="" disabled>국가를 선택하세요</option>
      {options.map((option) => <option key={option.countryId} value={option.countryId}>
        {option.name} · {option.countryId} · {option.role === "player" ? "플레이 국가" : "외국"}
      </option>)}
    </select>
  </label>;
}
