"use client";

import {useMemo, useState} from "react";
import {
  type CountrySearchEntry,
  searchCountryProjection,
} from "@/lib/projection/country-search-index-patch";
import {useGameSetupStore} from "@/stores/game-setup-store";

export function MapSearch() {
  const query = useGameSetupStore((state) => state.searchQuery);
  const setQuery = useGameSetupStore((state) => state.setSearchQuery);
  const select = useGameSetupStore((state) => state.selectCountry);
  const projection = useGameSetupStore((state) => state.countrySearchProjection);
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchCountryProjection(projection, query), [projection, query]);
  const choose = (entry: CountrySearchEntry) => {
    select(entry.countryId);
    setQuery("");
    setActive(0);
    window.dispatchEvent(new CustomEvent("pax:focus-country", {detail: entry.countryId}));
  };

  return (
    <div className="search">
      <label className="sr-only" htmlFor="country-search">국가 검색</label>
      <input
        id="country-search"
        value={query}
        placeholder="국가 검색 · 한국어, English, ISO3"
        autoComplete="off"
        aria-controls="country-results"
        aria-expanded={!!query}
        aria-activedescendant={
          query && results[active] ? `country-${results[active].countryId}` : undefined
        }
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, results.length - 1));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          }
          if (event.key === "Enter" && results[active]) choose(results[active]);
          if (event.key === "Escape") setQuery("");
        }}
      />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m16 16 5 5" />
      </svg>
      {query && (
        <ul className="results" id="country-results" role="listbox">
          {results.map((entry, index) => (
            <li
              key={entry.countryId}
              role="option"
              aria-selected={index === active}
              id={`country-${entry.countryId}`}
            >
              <button
                className={`result ${index === active ? "active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(entry)}
              >
                <span><b>{entry.mapKo}</b> · {entry.english}</span>
                <small>{entry.countryId}</small>
              </button>
            </li>
          ))}
          {!results.length && <li className="empty">검색 결과가 없습니다</li>}
        </ul>
      )}
    </div>
  );
}
