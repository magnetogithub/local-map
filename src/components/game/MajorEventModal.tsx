"use client";

import {useEffect, useRef} from "react";

import type {MajorEventQueueEntry} from "@/lib/game-ui/major-event-queue";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {GameStatusBadge} from "./GamePanel";

export function MajorEventModal({entry, countryNames, onViewOnMap, onAcknowledge}: Readonly<{
  entry: MajorEventQueueEntry;
  countryNames: Readonly<Record<string, string>>;
  onViewOnMap(countryId: ActiveCountryId): void;
  onAcknowledge(): void;
}>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    acknowledgeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        acknowledgeRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);
  const primaryCountryId = entry.event.countryIds.find((countryId) => countryNames[countryId] !== undefined) as ActiveCountryId | undefined;
  return <div className="game-major-event-layer" data-layer="major-modal">
    <div ref={dialogRef} className="game-major-event" role="dialog" aria-modal="true" aria-labelledby="major-event-title" aria-describedby="major-event-description">
      <header><div><span>주요 사건 · {entry.ordinal} / {entry.total}</span><time dateTime={entry.event.date}>{entry.event.date}</time></div><GameStatusBadge tone={entry.event.significance === "transformative" ? "error" : "warning"}>{entry.event.significance === "transformative" ? "변혁" : "주요"}</GameStatusBadge></header>
      <h2 id="major-event-title">{entry.event.title}</h2>
      <p id="major-event-description">{entry.event.narrative}</p>
      <dl className="game-management-facts"><div><dt>관련 국가</dt><dd>{entry.event.countryIds.map((id) => countryNames[id] ?? id).join(" · ")}</dd></div><div><dt>지도 변화</dt><dd>{entry.event.hasMapChanges ? "지도에 반영됨" : "즉시 지도 변화 없음"}</dd></div></dl>
      <div className="game-major-event__actions">
        <button type="button" disabled={!primaryCountryId} onClick={() => primaryCountryId && onViewOnMap(primaryCountryId)}>지도에서 보기</button>
        <button ref={acknowledgeRef} type="button" className="game-major-event__acknowledge" onClick={onAcknowledge}>확인</button>
      </div>
      <p className="game-major-event__policy">Escape로 닫을 수 없습니다. 사건을 확인해야 다음 진행이 가능합니다.</p>
    </div>
  </div>;
}
