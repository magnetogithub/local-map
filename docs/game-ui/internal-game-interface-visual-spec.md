# Internal game interface visual specification

## Viewport wireframes

1920x1080 (management overlay open):

```text
+--------------------------------------------------------------------------------+
| [player badge]             [population | economy | alerts | actions | wars] [date]|
|                                                                            [phase]|
|                                                                         [stop]    |
|  +edge+       MAP CANVAS (continues beneath every chrome surface)   +----------+  |
|  |Pol |                                                         x   | Overlay  |  |
|  |Eco |                                      management window --->| heading  |  |
|  |Dip |                                                         |   | content  |  |
|  |War |                                                         |   | scroll   |  |
|  |Act |                                                         |   | owner    |  |
|  |News|                                                         |   |          |  |
|  |Save|                                                         |   |          |  |
|  |Set |                                                         |   +----------+  |
|  +----+                                                                        |
+--------------------------------------------------------------------------------+
```

1280x720 uses the same topology. The top-center HUD may compress labels but does not wrap;
the edge menu remains fully reachable. The overlay is 400 px wide and at most the viewport
height minus 32 px. Its body, not the page or map, scrolls.

```text
+--------------------------------------------------------------------+
|[badge]       [population|economy|alerts|actions|wars] [date/turn]   |
|[edge]                MAP                         +-----------------+ |
|| P |                                             | overlay (400)   | |
|| E |                                             | own scrollbar   | |
|| D |                                             |                 | |
|| W |                                             |                 | |
|| A |                                             |                 | |
|| N |                                             |                 | |
|| S |                                             +-----------------+ |
+--------------------------------------------------------------------+
```

When the major-event modal is present, a dimmer covers both map and overlay. The modal is
centered, 560-720 px wide, and its body owns overflow. The primary acknowledgement button
is always visible in a sticky footer.

## Layout tokens

| Token | 1920 target | 1280 target / rule |
| --- | --- | --- |
| `--game-safe` | 24 px | 16 px |
| `--game-top-hud-height` | 72 px | 64 px |
| `--game-edge-width` | 64 px | 56 px |
| `--game-overlay-width` | 480 px | 400 px |
| `--game-overlay-max-height` | `calc(100dvh - 48px)` | `calc(100dvh - 32px)` |
| `--game-radius` | 3 px | 3 px |
| `--game-focus` | 3 px solid `#f1b84b` | same |
| `--game-panel-bg` | `rgba(247,244,235,.97)` | same |
| `--game-ink` | `#182329` | same |
| `--game-muted` | `#667579` | same |

Typography uses the repository's existing Georgia/Noto Serif KR display stack and
Arial/Noto Sans KR UI stack. External game fonts, icons, textures, portraits, and other
game assets are not dependencies. Icons must be repository-authored primitives or text and
must always have a visible label or accessible name.

## Layer order

Use only these named tokens; components must not invent large z-index values.

| Token | z-index | Content |
| --- | ---: | --- |
| `--z-map` | 0 | Map canvas |
| `--z-map-ui` | 10 | Map controls, labels, legend |
| `--z-hud` | 20 | Top HUD chrome |
| `--z-edge-nav` | 30 | Edge navigation |
| `--z-overlay` | 40 | Single management overlay |
| `--z-toast` | 50 | Transient status/live region |
| `--z-major-modal` | 60 | Dimmer and acknowledgement modal |
| `--z-fatal` | 70 | Fatal/unsupported-screen layer |

## Scroll, focus, and motion

- `html`, `body`, game root, and map remain `overflow: hidden`.
- Only `.game-overlay__body` and `.major-event-modal__body` use `overflow: auto`.
- Focus order with no overlay: player badge, HUD shortcuts, date/Stop, edge items, map
  controls. With an overlay: close button, heading context, body controls, sticky actions.
- Opening moves focus into the window; Escape/close restores the invoker. The modal traps
  focus and prevents overlay/map interaction until the FIFO item is acknowledged.
- Status changes use a polite live region; failures and blocking-event arrival use assertive
  announcements without repeatedly reading streaming draft text.
- Under `prefers-reduced-motion: reduce`, overlay transitions are removed and map focus uses
  an immediate jump instead of a fly animation.

## Content sizing rules

HUD items have a 44x44 px minimum target. Korean labels do not truncate the current date,
pending-major count, Stop, close, or acknowledgement controls. Optional descriptions may
ellipsize once. Relationship direction labels wrap rather than abbreviate. At 1280x720 no
primary control may fall outside the viewport.

