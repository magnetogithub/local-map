"use client";

import {useEffect} from "react";

export function GameOverlayEscapeHandler({onClose}: Readonly<{onClose(): void}>) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return null;
}
