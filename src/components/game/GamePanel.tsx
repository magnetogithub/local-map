"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

type TooltipPlacement = "bottom" | "right";
type TooltipAnchor = Readonly<{left: number; top: number; right: number; bottom: number}>;
type TooltipRequest = Readonly<{
  ownerId: string;
  text: string;
  placement: TooltipPlacement;
  anchor: TooltipAnchor;
}>;

type TooltipContextValue = Readonly<{
  show(request: TooltipRequest): void;
  hide(ownerId: string): void;
}>;

const TooltipContext = createContext<TooltipContextValue | null>(null);

function GlobalTooltipPopup({request}: Readonly<{request: TooltipRequest}>) {
  const popupRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({left: request.anchor.left, top: request.anchor.bottom + 8});

  useEffect(() => {
    const popup = popupRef.current;
    if (!popup) return;
    const margin = 8;
    const {width, height} = popup.getBoundingClientRect();
    const desiredLeft = request.placement === "right"
      ? request.anchor.right + 8
      : (request.anchor.left + request.anchor.right - width) / 2;
    const desiredTop = request.placement === "right"
      ? (request.anchor.top + request.anchor.bottom - height) / 2
      : request.anchor.bottom + 8;
    setPosition({
      left: Math.max(margin, Math.min(desiredLeft, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(desiredTop, window.innerHeight - height - margin)),
    });
  }, [request]);

  return (
    <span
      ref={popupRef}
      className="game-tooltip-popup"
      role="tooltip"
      style={{left: position.left, top: position.top}}
    >
      {request.text}
    </span>
  );
}

export function GameTooltipProvider({children}: Readonly<{children: ReactNode}>) {
  const [tooltip, setTooltip] = useState<TooltipRequest | null>(null);
  const show = useCallback((request: TooltipRequest) => setTooltip(request), []);
  const hide = useCallback((ownerId: string) => {
    setTooltip((current) => current?.ownerId === ownerId ? null : current);
  }, []);
  const context = useMemo(() => ({show, hide}), [hide, show]);
  return (
    <TooltipContext.Provider value={context}>
      {children}
      <div className="game-tooltip-layer" data-layer="tooltip" aria-live="polite">
        {tooltip && <GlobalTooltipPopup request={tooltip}/>}
      </div>
    </TooltipContext.Provider>
  );
}

export function GamePanel({
  title,
  eyebrow,
  onClose,
  children,
}: Readonly<{
  title: string;
  eyebrow?: string;
  onClose(): void;
  children: ReactNode;
}>) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);
  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
    ) ?? [])];
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
  return (
    <aside ref={panelRef} className="game-panel" data-testid="game-panel" aria-labelledby="game-panel-title" onKeyDown={trapFocus}>
      <header className="game-panel__titlebar">
        <div>
          {eyebrow && <span className="game-panel__eyebrow">{eyebrow}</span>}
          <h2 id="game-panel-title">{title}</h2>
        </div>
        <button ref={closeRef} type="button" className="game-panel__close" onClick={onClose} aria-label={`${title} 닫기`}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="game-panel__body">{children}</div>
    </aside>
  );
}

export function GameEmptyState({
  title,
  description,
}: Readonly<{title: string; description: string}>) {
  return (
    <div className="game-empty-state">
      <span className="game-empty-state__mark" aria-hidden="true">◇</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

export function GameLoadingState({title}: Readonly<{title: string}>) {
  return <div className="game-loading-state" role="status" aria-label={title}>
    <span/><span/><span/>
    <p>{title}</p>
  </div>;
}

export function GameStatusBadge({
  tone = "neutral",
  children,
}: Readonly<{tone?: "neutral" | "active" | "warning" | "error"; children: ReactNode}>) {
  return <span className="game-status-badge" data-tone={tone}>{children}</span>;
}

export function GameTooltip({
  text,
  placement = "bottom",
  children,
}: Readonly<{text: string; placement?: TooltipPlacement; children: ReactNode}>) {
  const context = useContext(TooltipContext);
  const ownerId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const modes = useRef({hover: false, focus: false});
  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!context || !rect) return;
    context.show({
      ownerId,
      text,
      placement,
      anchor: {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom},
    });
  };
  const hideIfInactive = () => {
    if (!modes.current.hover && !modes.current.focus) context?.hide(ownerId);
  };
  useEffect(() => () => context?.hide(ownerId), [context, ownerId]);
  return (
    <span
      ref={triggerRef}
      className="game-tooltip"
      onMouseEnter={() => { modes.current.hover = true; show(); }}
      onMouseLeave={() => { modes.current.hover = false; hideIfInactive(); }}
      onFocusCapture={() => { modes.current.focus = true; show(); }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          modes.current.focus = false;
          hideIfInactive();
        }
      }}
    >
      {children}
    </span>
  );
}

