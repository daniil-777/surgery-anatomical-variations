# VISCERA Studio Shell: Apple-style design spec (v1, 2026-10-21)

**Stack:** React 19.3, plain CSS with no Tailwind, `lucide-react` (already a dependency), Vite 6.
**Target look:** macOS 26/27 Liquid Glass with macOS density, plus iPadOS adaptations for touch.
**Token prefix:** `--px-`. Class prefix: `.px-`.
**Scope:** the app shell (auth, sidebar, toolbar, Home, Projects, Library, Imports, the project editor frame, Version History, Account). The labs (Organ, Tissue, Fat, Blood, Physics) mount inside the shell and keep their own internals (§5).

---

## 0. Ground rules and decisions (read first)

1. **Two layers.** Glass is allowed only on the functional layer: sidebar, toolbar items, popovers and menus, sheets, HUDs. Grids, forms, the inspector and the WebGL viewport never use glass. HIG: "Don't use Liquid Glass in the content layer… use sparingly."
2. **No `backdrop-filter` over a WebGL canvas.** Blurring a live 3D frame re-samples it every frame and competes with the renderer (the Tissue Lab records 3840×2160).
   - In lab routes, floating panels over the viewport use the `*-solid` materials.
   - Only small HUD chips (at most 3 per viewport) may blur.
3. **Lab routes render the whole window in Dark appearance.** This follows the Photos precedent, which switches to dark in Edit mode. It also keeps the current dark-only lab CSS pixel-identical.
   - Home, Library, Imports, Projects and Account follow the system appearance (Light/Dark/Auto).
4. **Density.** Desktop uses macOS metrics: 13px body, 24px medium controls, 28px rows, 52px unified toolbar.
   - `@media (pointer: coarse)` swaps in iPadOS metrics: targets of 36–44px, and 16px input text so iOS Safari doesn't zoom on focus.
5. **Colours.**
   - Exact HIG system colours are kept as a reference palette (`--px-system-*`).
   - Text and interactive tokens are tuned for WCAG AA wherever the HIG value fails: text needs 4.5:1 and UI needs 3:1.
   - Every shipped ratio was computed (§1.2).
6. **Glass follows the macOS 27 refinements (WWDC26):**
   - more diffusion of the background (30–50px blur);
   - a darkened edge ring and a brighter top highlight;
   - a "uniform" toolbar bar that appears when content scrolls under it;
   - a user glass level (Clear / Regular / Tinted), like the new system transparency slider;
   - full solid fallbacks.
7. **Fonts.** SF comes from the local system via `-apple-system`. Never self-host SF Pro; its licence covers Apple platforms only. Inter (already bundled) is the fallback and has its own tracking table. Add `@fontsource-variable/inter` so weights 700/800 and optical sizing exist; today only 400/500/600 are bundled.
8. **Icons.** SF Symbols are licensed for Apple-platform apps only, so use lucide-react at `strokeWidth={1.75}` (≤16px) or `1.5` (≥20px). The mapping is in §2.0.
9. **Overlays use the browser top layer.**
   - Sheets and alerts: `<dialog>.showModal()`.
   - Menus, popovers, toasts and tooltips: the `popover` attribute.
   - Positioning: `@floating-ui/react-dom`.
   - z-index tokens are only for in-flow layers.
10. **Theming uses `light-dark()`.** It resolves against the `color-scheme` of the element that uses the token. That makes forced-dark subtrees (labs, HUDs) correct automatically, with no derived-token bugs.
11. **Isolation ("work separately").**
    - The shell lives in its own package and folder. Labs mount through the LabHost contract (§5).
    - The shell never imports lab internals.
    - The Tissue Lab keeps its existing rule: no imports from `../fat/`.
    - Shell CSS never restyles lab DOM.
12. **Browser reality for shortcuts.**
    - ⌘N, ⌘T, ⌘W, ⌘Q and ⌘⇧N/T/W never reach the page.
    - ⌥⌘I opens DevTools in Chrome.
    - Never override ⌘+ / ⌘− (page zoom is an accessibility feature).
    - The final mapping is in §4.1.

---

## 1. Design tokens

### 1.1 Wiring

```html
<html class="px-shell"
      data-px-theme="system|light|dark"      <!-- user choice; default system -->
      data-px-route="auth|app|lab"            <!-- lab ⇒ forced dark -->
      data-px-font="sf|inter"                 <!-- set by boot script -->
      data-px-glass="regular|clear|tinted"    <!-- Account ▸ Appearance -->
      data-px-transparency="system|reduce"    <!-- manual Reduce Transparency (Safari lacks the media query) -->
      data-px-density="regular|compact">      <!-- compact inside labs -->
```

**Load order:** `packages/ui/src/tokens.css` (legacy), then `px-tokens.css`, then `px-base.css`, then component CSS. Theme attributes live on `<html>` so that portals and top-layer elements inherit them.

**Boot script.** Inline it in `index.html` before CSS paints, so there is no flash:

```js
(() => { const d = document.documentElement, ua = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  d.dataset.pxFont = /Mac|iPhone|iPad|iPod/i.test(ua) ? "sf" : "inter";   // iPadOS reports "MacIntel"
  try { const p = JSON.parse(localStorage.getItem("viscera.px.appearance.v1") ?? "{}");
        d.dataset.pxTheme = p.theme ?? "system"; d.dataset.pxGlass = p.glass ?? "regular";
        d.dataset.pxTransparency = p.transparency ?? "system"; } catch { d.dataset.pxTheme = "system"; } })();
```

### 1.2 Colour: shipped values and why they differ from Apple's

Measured on the surfaces each token actually sits on:

- **Light:** `#FFF` content, `#ECECEC` window, `#E8E8ED` sidebar.
- **Dark:** `#1E1E1E` content, `#323232` window, `#3A3A3C` popover.

| Token | Light | Dark | Apple reference | Contrast (worst surface) |
|---|---|---|---|---|
| `--px-label` | `rgba(0,0,0,.85)` | `rgba(255,255,255,.85)` | NSColor.labelColor | 12.9 / 8.7 |
| `--px-label-secondary` | `rgba(0,0,0,.56)` | `rgba(255,255,255,.55)` | Apple light uses .50, which gives 3.8:1 and fails AA, so we ship .56 | 4.69 / 4.67 |
| `--px-label-tertiary` | `rgba(0,0,0,.26)` | `rgba(255,255,255,.25)` | tertiaryLabelColor | disabled or placeholder only |
| `--px-label-quaternary` | `rgba(0,0,0,.10)` | `rgba(255,255,255,.10)` | quaternaryLabelColor | decorative only |
| `--px-accent` (UI: rings, checkmarks, switches, progress) | `#0071E3` | `#0091FF` | systemBlue `#0088FF` is 2.98:1 on `#ECECEC`, below the 3:1 needed for UI | 3.85 / 3.51 |
| `--px-accent-text` (links, plain buttons) | `#0062CC` | `#5CB8FF` | linkColor `#0068DA`/`#419CFF` fails on window/popover | 4.75 / 5.27 |
| `--px-accent-fill` (white text) | `#0071E3` | `#0071E3` | apple.com CTA blue | white 4.70 (hover `#0066CC` 5.57, pressed `#005BB5` 6.64) |
| `--px-selection` (white text) | `#0063E1` | `#0058D0` | selectedContentBackgroundColor | white 5.42 / 6.35 |
| `--px-danger-text` | `#CC0014` | `#FF8285` | systemRed is 3.0:1 light, so it can't be text | 4.81 / 4.75 |
| `--px-danger-fill` (white text) | `#E9152D` | `#E9152D` | systemRed, increased contrast | 4.56 |
| `--px-success-text` | `#00752B` | `#30D158` | systemGreen is 1.9:1 light | 4.80 / 5.61 |
| `--px-warning-text` | `#AD4800` | `#FFA056` | systemOrange, increased contrast (dark) | 4.64 / 5.63 |

Every other colour in the table below is exact HIG or AppKit/UIKit, sampled in sRGB.

### 1.3 `px-tokens.css` (complete)

```css
/* ==== VISCERA px tokens v1 — every custom property uses the --px- prefix ==== */
:root {
  /* 1 · Reference palette — HIG "System colors" 2025+ table (light, dark) */
  --px-system-red:    light-dark(#FF383C, #FF4245);
  --px-system-orange: light-dark(#FF8D28, #FF9230);
  --px-system-yellow: light-dark(#FFCC00, #FFD600);
  --px-system-green:  light-dark(#34C759, #30D158);
  --px-system-mint:   light-dark(#00C8B3, #00DAC3);
  --px-system-teal:   light-dark(#00C3D0, #00D2E0);
  --px-system-cyan:   light-dark(#00C0E8, #3CD3FE);
  --px-system-blue:   light-dark(#0088FF, #0091FF);
  --px-system-indigo: light-dark(#6155F5, #6D7CFF);
  --px-system-purple: light-dark(#CB30E0, #DB34F2);
  --px-system-pink:   light-dark(#FF2D55, #FF375F);
  --px-system-brown:  light-dark(#AC7F5E, #B78A66);
  --px-system-gray:   #8E8E93;
  --px-system-gray2:  light-dark(#AEAEB2, #636366);
  --px-system-gray3:  light-dark(#C7C7CC, #48484A);
  --px-system-gray4:  light-dark(#D1D1D6, #3A3A3C);
  --px-system-gray5:  light-dark(#E5E5EA, #2C2C2E);
  --px-system-gray6:  light-dark(#F2F2F7, #1C1C1E);

  /* 2 · Labels (AppKit label colors; secondary raised to .56 in light for AA) */
  --px-label:             light-dark(rgba(0,0,0,.85), rgba(255,255,255,.85));
  --px-label-secondary:   light-dark(rgba(0,0,0,.56), rgba(255,255,255,.55));
  --px-label-tertiary:    light-dark(rgba(0,0,0,.26), rgba(255,255,255,.25));
  --px-label-quaternary:  light-dark(rgba(0,0,0,.10), rgba(255,255,255,.10));
  --px-placeholder:       light-dark(rgba(0,0,0,.25), rgba(255,255,255,.25));
  --px-label-on-fill:     #FFFFFF;                 /* on accent / danger / selection fills */
  --px-label-hud:         #FFFFFF;
  --px-label-hud-secondary: rgba(255,255,255,.70); /* 5.4:1 on HUD even over white */

  /* 3 · Separators & strokes */
  --px-hairline:          1px;                     /* 0.5px on ≥2dppx (below) */
  --px-separator:         light-dark(rgba(0,0,0,.10), rgba(255,255,255,.10));   /* separatorColor */
  --px-separator-opaque:  light-dark(#C6C6C8, #38383A);                          /* opaqueSeparator */
  --px-border-control:    light-dark(rgba(0,0,0,.14), rgba(255,255,255,.12));
  --px-image-outline:     light-dark(rgba(0,0,0,.10), rgba(255,255,255,.10));

  /* 4 · Backgrounds */
  --px-bg-window:         light-dark(#ECECEC, #323232);  /* windowBackgroundColor */
  --px-bg-content:        light-dark(#FFFFFF, #1E1E1E);  /* controlBackground / textBackground */
  --px-bg-content-alt:    light-dark(#F4F5F5, #292929);  /* alternating rows */
  --px-bg-underpage:      light-dark(#9F9F9F, #292929);  /* underPageBackground rgba(150,150,150,.9)/rgba(40,40,40,.9) composited */
  --px-bg-grouped:        light-dark(#F2F2F7, #1C1C1E);  /* grouped page (sheet forms) */
  --px-bg-grouped-row:    light-dark(#FFFFFF, #2C2C2E);  /* grouped section boxes */
  --px-bg-elevated:       light-dark(#FFFFFF, #2C2C2E);
  --px-bg-control:        light-dark(#FFFFFF, rgba(255,255,255,.10));
  --px-bg-control-hover:  light-dark(#F7F7F8, rgba(255,255,255,.14));
  --px-bg-control-pressed:light-dark(#EBEBED, rgba(255,255,255,.20));
  --px-bg-field:          light-dark(#FFFFFF, rgba(255,255,255,.05));
  --px-bg-thumb:          light-dark(#F2F2F7, #2C2C2E);
  --px-bg-stage:          #18181A;                       /* lab viewport surround, always dark */

  /* 5 · Fills (UIKit systemFill family) */
  --px-fill:              light-dark(rgba(120,120,128,.20), rgba(120,120,128,.36));
  --px-fill-secondary:    light-dark(rgba(120,120,128,.16), rgba(120,120,128,.32));
  --px-fill-tertiary:     light-dark(rgba(118,118,128,.12), rgba(118,118,128,.24));
  --px-fill-quaternary:   light-dark(rgba(116,116,128,.08), rgba(118,118,128,.18));

  /* 6 · Accent, selection, focus */
  --px-accent:            light-dark(#0071E3, #0091FF);
  --px-accent-text:       light-dark(#0062CC, #5CB8FF);
  --px-accent-fill:       #0071E3;
  --px-accent-fill-hover: #0066CC;
  --px-accent-fill-pressed: #005BB5;
  --px-accent-tint:       light-dark(rgba(0,113,227,.12), rgba(0,145,255,.20));
  --px-selection:         light-dark(#0063E1, #0058D0);
  --px-selection-unemphasized: light-dark(#DCDCDC, #464646);
  --px-focus-ring:        var(--px-accent);
  --px-focus-halo:        light-dark(rgba(0,113,227,.25), rgba(0,145,255,.35));

  /* 7 · Status */
  --px-danger:            var(--px-system-red);
  --px-danger-text:       light-dark(#CC0014, #FF8285);
  --px-danger-fill:       #E9152D;  --px-danger-fill-hover: #D70015;  --px-danger-fill-pressed: #C40012;
  --px-success:           var(--px-system-green);
  --px-success-text:      light-dark(#00752B, #30D158);
  --px-warning:           var(--px-system-orange);
  --px-warning-text:      light-dark(#AD4800, #FFA056);
  --px-caution:           var(--px-system-yellow);

  /* 8 · Identity (fixed colours, used sparingly — HIG allows fixed sidebar/icon colours with meaning) */
  --px-brand:             #FF5C6C;   /* existing VISCERA coral (packages/ui --accent): logo only, never interactive */
  --px-lab-organ:         var(--px-system-pink);
  --px-lab-tissue:        var(--px-system-orange);
  --px-lab-fat:           var(--px-system-yellow);
  --px-lab-blood:         var(--px-system-red);
  --px-lab-physics:       var(--px-system-indigo);

  /* 9 · Typography */
  --px-font-sans:    -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Inter Variable", "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --px-font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, "Inter Variable", "Segoe UI Variable Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --px-font-mono:    ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
  --px-text-scale:   var(--ui-text-scale, 1);   /* honours the existing Display Settings (80–200 %) */
  --px-fw-regular: 400; --px-fw-medium: 500; --px-fw-semibold: 600; --px-fw-bold: 700; --px-fw-heavy: 800;
  /* macOS built-in text styles (HIG): size / line height */
  --px-fs-large-title: calc(26px * var(--px-text-scale)); --px-lh-large-title: calc(32px * var(--px-text-scale));
  --px-fs-title1:      calc(22px * var(--px-text-scale)); --px-lh-title1:      calc(26px * var(--px-text-scale));
  --px-fs-title2:      calc(17px * var(--px-text-scale)); --px-lh-title2:      calc(22px * var(--px-text-scale));
  --px-fs-title3:      calc(15px * var(--px-text-scale)); --px-lh-title3:      calc(20px * var(--px-text-scale));
  --px-fs-headline:    calc(13px * var(--px-text-scale)); --px-lh-headline:    calc(16px * var(--px-text-scale));
  --px-fs-body:        calc(13px * var(--px-text-scale)); --px-lh-body:        calc(16px * var(--px-text-scale));
  --px-fs-callout:     calc(12px * var(--px-text-scale)); --px-lh-callout:     calc(15px * var(--px-text-scale));
  --px-fs-subheadline: max(10px, calc(11px * var(--px-text-scale))); --px-lh-subheadline: max(13px, calc(14px * var(--px-text-scale)));
  --px-fs-footnote:    max(10px, calc(10px * var(--px-text-scale))); --px-lh-footnote:    max(13px, calc(13px * var(--px-text-scale)));
  --px-fs-caption:     max(10px, calc(10px * var(--px-text-scale))); --px-lh-caption:     max(13px, calc(13px * var(--px-text-scale)));
  --px-fs-input:       var(--px-fs-body);
  /* tracking — SF Pro table (1/1000 em ÷ 1000) */
  --px-tr-large-title: .008em; --px-tr-title1: -.012em; --px-tr-title2: -.026em; --px-tr-title3: -.016em;
  --px-tr-headline: -.006em; --px-tr-body: -.006em; --px-tr-callout: 0em; --px-tr-subheadline: .006em;
  --px-tr-footnote: .012em; --px-tr-caption: .012em;

  /* 10 · Spacing (named by pixel value) */
  --px-space-2: 2px; --px-space-4: 4px; --px-space-6: 6px; --px-space-8: 8px; --px-space-10: 10px;
  --px-space-12: 12px; --px-space-16: 16px; --px-space-20: 20px; --px-space-24: 24px; --px-space-32: 32px;
  --px-space-40: 40px; --px-space-48: 48px; --px-space-64: 64px;

  /* 11 · Sizes */
  --px-toolbar-h: 52px;  --px-toolbar-item-h: 36px;  --px-panel-inset: 8px;
  --px-sidebar-w: 240px; --px-sidebar-w-min: 220px; --px-sidebar-w-max: 260px; --px-sidebar-row-h: 28px;
  --px-inspector-w: 280px; --px-inspector-w-min: 240px; --px-inspector-w-max: 360px;
  --px-version-panel-w: 320px;
  --px-ctl-h-sm: 20px; --px-ctl-h-md: 24px; --px-ctl-h-lg: 28px; --px-ctl-h-xl: 36px; --px-ctl-h-auth: 40px;
  --px-row-h: 28px; --px-menu-row-h: 24px;
  --px-hit-min: 24px;                       /* WCAG 2.2 AA 2.5.8; macOS default target is 28 */
  --px-icon-sm: 12px; --px-icon-md: 16px; --px-icon-lg: 20px; --px-icon-toolbar: 17px;
  --px-content-pad-x: 24px; --px-content-pad-top: 20px;

  /* 12 · Radii (concentric map in §1.4) */
  --px-radius-window: 26px;  --px-radius-panel: 18px;  --px-radius-sheet: 20px;
  --px-radius-popover: 14px; --px-radius-menu: 12px;   --px-radius-menu-item: 7px;
  --px-radius-card: 14px;    --px-radius-thumb: 10px;  --px-radius-sidebar-item: 8px;
  --px-radius-control-sm: 5px; --px-radius-control: 7px; --px-radius-field-xl: 10px;
  --px-radius-small: 4px;    --px-radius-capsule: 9999px;

  /* 13 · Materials (tint · filter · solid fallback). --px-glass-k = user glass level */
  --px-glass-k: 1;
  --px-mat-sidebar:        light-dark(rgb(226 226 232 / min(1, .70 * var(--px-glass-k))), rgb(46 46 50 / min(1, .70 * var(--px-glass-k))));
  --px-mat-sidebar-solid:  light-dark(#EBEBEF, #29292C);
  --px-mat-sidebar-filter: blur(30px) saturate(180%);
  --px-mat-toolbar-item:        light-dark(rgb(255 255 255 / min(1, .72 * var(--px-glass-k))), rgb(64 64 68 / min(1, .62 * var(--px-glass-k))));
  --px-mat-toolbar-item-solid:  light-dark(#FFFFFF, #3A3A3C);
  --px-mat-toolbar-filter:      blur(20px) saturate(180%);
  --px-mat-bar:            light-dark(rgb(250 250 252 / min(1, .80 * var(--px-glass-k))), rgb(30 30 32 / min(1, .78 * var(--px-glass-k))));
  --px-mat-bar-solid:      light-dark(#FAFAFC, #1F1F21);
  --px-mat-bar-filter:     blur(24px) saturate(180%);
  --px-mat-popover:        light-dark(rgb(246 246 248 / min(1, .82 * max(1, var(--px-glass-k)))), rgb(50 50 54 / min(1, .82 * max(1, var(--px-glass-k)))));
  --px-mat-popover-solid:  light-dark(#F6F6F8, #2E2E31);
  --px-mat-popover-filter: blur(40px) saturate(180%);
  --px-mat-sheet:          light-dark(rgb(248 248 250 / .88), rgb(44 44 48 / .90));
  --px-mat-sheet-solid:    light-dark(#F5F5F7, #2C2C2E);
  --px-mat-sheet-filter:   blur(50px) saturate(180%);
  --px-mat-hud:            rgb(28 28 30 / .80);
  --px-mat-hud-solid:      #1C1C1E;
  --px-mat-hud-filter:     blur(24px) saturate(160%);
  --px-mat-scrim:          light-dark(rgba(0,0,0,.20), rgba(0,0,0,.45));
  --px-glass-edge:         light-dark(rgba(0,0,0,.10), rgba(0,0,0,.55));     /* macOS 27 darkened edge */
  --px-glass-highlight:    light-dark(rgba(255,255,255,.80), rgba(255,255,255,.14)); /* top specular */

  /* 14 · Shadows / elevation */
  --px-inner-highlight: inset 0 var(--px-hairline) 0 var(--px-glass-highlight);
  --px-shadow-1: 0 0 0 var(--px-hairline) var(--px-border-control), 0 1px 1.5px light-dark(rgba(0,0,0,.10), rgba(0,0,0,.40));                       /* controls */
  --px-shadow-2: 0 1px 3px light-dark(rgba(0,0,0,.08), rgba(0,0,0,.35)), 0 6px 16px light-dark(rgba(0,0,0,.08), rgba(0,0,0,.30));                  /* raised, glass items, drag */
  --px-shadow-3: 0 0 0 var(--px-hairline) var(--px-glass-edge), 0 4px 10px light-dark(rgba(0,0,0,.08), rgba(0,0,0,.30)), 0 12px 32px light-dark(rgba(0,0,0,.14), rgba(0,0,0,.45)); /* popover, menu, toast */
  --px-shadow-4: 0 0 0 var(--px-hairline) var(--px-glass-edge), 0 2px 8px light-dark(rgba(0,0,0,.06), rgba(0,0,0,.30)), 0 12px 32px light-dark(rgba(0,0,0,.08), rgba(0,0,0,.35)); /* floating sidebar/panels */
  --px-shadow-5: 0 0 0 var(--px-hairline) var(--px-glass-edge), 0 8px 24px light-dark(rgba(0,0,0,.10), rgba(0,0,0,.35)), 0 24px 64px light-dark(rgba(0,0,0,.18), rgba(0,0,0,.55)); /* sheet */
  --px-shadow-6: 0 0 0 var(--px-hairline) var(--px-glass-edge), 0 12px 32px light-dark(rgba(0,0,0,.10), rgba(0,0,0,.35)), 0 32px 80px light-dark(rgba(0,0,0,.20), rgba(0,0,0,.60)); /* window-like card */

  /* 15 · Motion (Core Animation curves + numerically fitted springs) */
  --px-dur-press: 90ms; --px-dur-fast: 150ms; --px-dur-base: 200ms; --px-dur-medium: 250ms; --px-dur-slow: 350ms;
  --px-ease-default:    cubic-bezier(.25,.1,.25,1);   /* CAMediaTimingFunction default */
  --px-ease-in:         cubic-bezier(.42,0,1,1);      /* CA easeIn — exits */
  --px-ease-out:        cubic-bezier(0,0,.58,1);      /* CA easeOut — state changes */
  --px-ease-in-out:     cubic-bezier(.42,0,.58,1);    /* CA easeInEaseOut — moves */
  --px-ease-emphasized: cubic-bezier(.32,.72,0,1);    /* sheets, panels, sidebar */
  /* SwiftUI-style springs (response r, damping ζ = 1 − bounce); duration = settle to 0.1 % */
  --px-spring-smooth: linear(0, 0.004 1%, 0.019 2.2%, 0.079 5%, 0.161 7.8%, 0.465 17%, 0.557 20.2%, 0.638 23.5%, 0.706 26.8%, 0.767 30.2%, 0.817 33.8%, 0.86 37.5%, 0.899 42%, 0.929 46.8%, 0.953 52.2%, 0.971 58.5%, 0.991 73.8%, 1); /* r .35s ζ1 */
  --px-dur-spring-smooth: 515ms;
  --px-spring-snappy: linear(0, 0.006 1.2%, 0.025 2.8%, 0.056 4.2%, 0.095 5.8%, 0.19 8.8%, 0.511 18%, 0.61 21.2%, 0.695 24.5%, 0.762 27.5%, 0.823 30.8%, 0.871 34%, 0.912 37.5%, 0.944 41.2%, 0.97 45.5%, 0.988 50.2%, 1 55.8%, 1.006 68%, 1); /* r .35s ζ.85, 0.6 % overshoot */
  --px-dur-spring-snappy: 490ms;
  --px-spring-bouncy: linear(0, 0.008 1.2%, 0.029 2.5%, 0.062 3.8%, 0.112 5.2%, 0.215 7.8%, 0.482 13.5%, 0.592 16%, 0.701 18.8%, 0.785 21.2%, 0.857 23.8%, 0.919 26.5%, 0.966 29.2%, 1.003 32.2%, 1.035 37%, 1.046 42.8%, 1.003 70.5%, 1); /* r .45s ζ.7, 4.6 % overshoot */
  --px-dur-spring-bouncy: 740ms;
  --px-press-scale: .97;  --px-motion-distance: 8px;  --px-motion-scale-from: .98;

  /* 16 · Z-index (in-flow only; overlays use the top layer) */
  --px-z-base: 0; --px-z-raised: 1; --px-z-sticky: 10; --px-z-toolbar: 20; --px-z-sidebar: 30; --px-z-inspector: 30;
  --px-z-floating-panel: 40; --px-z-drop-overlay: 50; --px-z-popover: 1000; --px-z-sheet: 1100; --px-z-toast: 1200;
  --px-z-tooltip: 1300; --px-z-drag-ghost: 1400;
}

/* Inter fallback: Inter dynamic-metrics tracking (a −0.0223, b 0.185, c −0.1745) */
:root[data-px-font="inter"] {
  --px-tr-large-title: -.020em; --px-tr-title1: -.018em; --px-tr-title2: -.013em; --px-tr-title3: -.009em;
  --px-tr-headline: -.003em; --px-tr-body: -.003em; --px-tr-callout: 0em; --px-tr-subheadline: .005em;
  --px-tr-footnote: .010em; --px-tr-caption: .010em;
}
@media (min-resolution: 2dppx) { :root { --px-hairline: .5px; } }

/* Glass level (Account ▸ Appearance ▸ Glass), mirrors the macOS 27 transparency slider */
:root[data-px-glass="clear"]  { --px-glass-k: .65; }
:root[data-px-glass="tinted"] { --px-glass-k: 1.36; }

/* Solid materials: no backdrop support / Reduce Transparency (system or manual) */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { :root {
  --px-mat-sidebar: var(--px-mat-sidebar-solid); --px-mat-toolbar-item: var(--px-mat-toolbar-item-solid);
  --px-mat-bar: var(--px-mat-bar-solid); --px-mat-popover: var(--px-mat-popover-solid);
  --px-mat-sheet: var(--px-mat-sheet-solid); --px-mat-hud: var(--px-mat-hud-solid); } }
@media (prefers-reduced-transparency: reduce) { :root {
  --px-mat-sidebar: var(--px-mat-sidebar-solid); --px-mat-toolbar-item: var(--px-mat-toolbar-item-solid);
  --px-mat-bar: var(--px-mat-bar-solid); --px-mat-popover: var(--px-mat-popover-solid);
  --px-mat-sheet: var(--px-mat-sheet-solid); --px-mat-hud: var(--px-mat-hud-solid);
  --px-mat-sidebar-filter: none; --px-mat-toolbar-filter: none; --px-mat-bar-filter: none;
  --px-mat-popover-filter: none; --px-mat-sheet-filter: none; --px-mat-hud-filter: none; } }
:root[data-px-transparency="reduce"] {
  --px-mat-sidebar: var(--px-mat-sidebar-solid); --px-mat-toolbar-item: var(--px-mat-toolbar-item-solid);
  --px-mat-bar: var(--px-mat-bar-solid); --px-mat-popover: var(--px-mat-popover-solid);
  --px-mat-sheet: var(--px-mat-sheet-solid); --px-mat-hud: var(--px-mat-hud-solid);
  --px-mat-sidebar-filter: none; --px-mat-toolbar-filter: none; --px-mat-bar-filter: none;
  --px-mat-popover-filter: none; --px-mat-sheet-filter: none; --px-mat-hud-filter: none; }

/* Increase Contrast: HIG "increased contrast" values + solid materials + stronger strokes */
@media (prefers-contrast: more) { :root {
  --px-system-red: light-dark(#E9152D, #FF6165);    --px-system-orange: light-dark(#C55300, #FFA056);
  --px-system-yellow: light-dark(#A16A00, #FEDF43); --px-system-green: light-dark(#008932, #4AD968);
  --px-system-mint: light-dark(#008575, #54DFCB);   --px-system-teal: light-dark(#008198, #3BDDEC);
  --px-system-cyan: light-dark(#007EAE, #6DD9FF);   --px-system-blue: light-dark(#1E6EF4, #5CB8FF);
  --px-system-indigo: light-dark(#564ADE, #A7AAFF); --px-system-purple: light-dark(#B02FC2, #EA8DFF);
  --px-system-pink: light-dark(#E7124D, #FF8AC4);   --px-system-brown: light-dark(#956D51, #DBA679);
  --px-system-gray: light-dark(#6C6C70, #AEAEB2);   --px-system-gray2: light-dark(#8E8E93, #7C7C80);
  --px-system-gray3: light-dark(#AEAEB2, #545456);  --px-system-gray4: light-dark(#BCBCC0, #444446);
  --px-system-gray5: light-dark(#D8D8DC, #363638);  --px-system-gray6: light-dark(#EBEBF0, #242426);
  --px-label-secondary: light-dark(rgba(0,0,0,.70), rgba(255,255,255,.72));
  --px-separator: light-dark(rgba(0,0,0,.30), rgba(255,255,255,.30));
  --px-border-control: light-dark(rgba(0,0,0,.45), rgba(255,255,255,.45));
  --px-glass-edge: light-dark(rgba(0,0,0,.35), rgba(255,255,255,.35));
  --px-mat-sidebar: var(--px-mat-sidebar-solid); --px-mat-toolbar-item: var(--px-mat-toolbar-item-solid);
  --px-mat-bar: var(--px-mat-bar-solid); --px-mat-popover: var(--px-mat-popover-solid);
  --px-mat-sheet: var(--px-mat-sheet-solid); --px-mat-hud: var(--px-mat-hud-solid); } }

/* Reduced motion: HIG "replace x/y/z transitions with fades, avoid animating blurs, tighten springs" */
@media (prefers-reduced-motion: reduce) { :root {
  --px-dur-slow: 200ms; --px-dur-medium: 150ms;
  --px-spring-smooth: var(--px-ease-out); --px-spring-snappy: var(--px-ease-out); --px-spring-bouncy: var(--px-ease-out);
  --px-dur-spring-smooth: 150ms; --px-dur-spring-snappy: 150ms; --px-dur-spring-bouncy: 150ms;
  --px-press-scale: 1; --px-motion-distance: 0px; --px-motion-scale-from: 1; } }

/* Density & touch (components read base size tokens directly — never alias size tokens at :root) */
[data-px-density="compact"] { --px-ctl-h-sm: 18px; --px-ctl-h-md: 22px; --px-ctl-h-lg: 26px; --px-ctl-h-xl: 32px;
  --px-row-h: 24px; --px-sidebar-row-h: 24px; --px-menu-row-h: 22px; }
@media (pointer: coarse) { :root { --px-ctl-h-sm: 28px; --px-ctl-h-md: 36px; --px-ctl-h-lg: 44px; --px-ctl-h-xl: 50px;
  --px-row-h: 44px; --px-sidebar-row-h: 44px; --px-menu-row-h: 44px; --px-hit-min: 44px; --px-fs-input: 16px; } }
```

### 1.4 Base scope, text styles, concentric radii

```css
/* px-base.css */
html.px-shell { color-scheme: light dark; }                                   /* overrides legacy :root{color-scheme:dark} */
html.px-shell[data-px-theme="light"] { color-scheme: light; }
html.px-shell[data-px-theme="dark"], html.px-shell[data-px-route="lab"] { color-scheme: dark; }

/* Shell typography applies to shell DOM only. Lab hosts re-declare the legacy base so labs stay pixel-identical. */
.px-app, .px-auth, .px-portal { font: var(--px-fw-regular) var(--px-fs-body)/var(--px-lh-body) var(--px-font-sans);
  letter-spacing: var(--px-tr-body); color: var(--px-label); font-feature-settings: normal; font-optical-sizing: auto;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
.px-lab-host { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px;
  letter-spacing: normal; font-feature-settings: "cv11", "ss01", "tnum"; color: var(--text-0); isolation: isolate; }

.px-num { font-variant-numeric: tabular-nums; }       /* counters, sizes, times, versions */
:where(.px-app, .px-auth) :is(h1, h2, h3, .px-balance) { text-wrap: balance; margin: 0; }
:where(.px-app, .px-auth) :is(p, .px-pretty) { text-wrap: pretty; }

.px-large-title { font: var(--px-fw-regular) var(--px-fs-large-title)/var(--px-lh-large-title) var(--px-font-display); letter-spacing: var(--px-tr-large-title); --px-fw-em: 700; }
.px-title1      { font: var(--px-fw-regular) var(--px-fs-title1)/var(--px-lh-title1) var(--px-font-display);           letter-spacing: var(--px-tr-title1); --px-fw-em: 700; }
.px-title2      { font: var(--px-fw-regular) var(--px-fs-title2)/var(--px-lh-title2) var(--px-font-sans);              letter-spacing: var(--px-tr-title2); --px-fw-em: 700; }
.px-title3      { font: var(--px-fw-regular) var(--px-fs-title3)/var(--px-lh-title3) var(--px-font-sans);              letter-spacing: var(--px-tr-title3); --px-fw-em: 600; }
.px-headline    { font: var(--px-fw-bold) var(--px-fs-headline)/var(--px-lh-headline) var(--px-font-sans);             letter-spacing: var(--px-tr-headline); --px-fw-em: 800; }
.px-body        { font: var(--px-fw-regular) var(--px-fs-body)/var(--px-lh-body) var(--px-font-sans);                  letter-spacing: var(--px-tr-body); --px-fw-em: 600; }
.px-callout     { font: var(--px-fw-regular) var(--px-fs-callout)/var(--px-lh-callout) var(--px-font-sans);            letter-spacing: var(--px-tr-callout); --px-fw-em: 600; }
.px-subheadline { font: var(--px-fw-regular) var(--px-fs-subheadline)/var(--px-lh-subheadline) var(--px-font-sans);    letter-spacing: var(--px-tr-subheadline); --px-fw-em: 600; }
.px-footnote    { font: var(--px-fw-regular) var(--px-fs-footnote)/var(--px-lh-footnote) var(--px-font-sans);          letter-spacing: var(--px-tr-footnote); --px-fw-em: 600; }
.px-caption1    { font: var(--px-fw-regular) var(--px-fs-caption)/var(--px-lh-caption) var(--px-font-sans);            letter-spacing: var(--px-tr-caption); --px-fw-em: 500; }
.px-caption2    { font: var(--px-fw-medium) var(--px-fs-caption)/var(--px-lh-caption) var(--px-font-sans);             letter-spacing: var(--px-tr-caption); --px-fw-em: 600; }
.px-em          { font-weight: var(--px-fw-em, 600); }
```

**Text style reference.** Values are from the HIG macOS table: size / line height, weight, emphasized weight.

| Style | Size/line | Weight | Emph. | Used for |
|---|---|---|---|---|
| Large Title | 26/32 | 400 | 700 | Rare: onboarding |
| Title 1 | 22/26 | 400 | 700 | Auth card title, Quick Look title |
| Title 2 | 17/22 | 400 | 700 | Page section headers ("Recent Projects"), empty-state titles |
| Title 3 | 15/20 | 400 | 600 | Toolbar title, sheet title, inspector item name |
| Headline | 13/16 | 700 | 800 | Alert title, grouped-box headers |
| Body | 13/16 | 400 | 600 | Default UI text, sidebar rows, card titles |
| Callout | 12/15 | 400 | 600 | Field labels, menu shortcuts |
| Subheadline | 11/14 | 400 | 600 | Metadata, sidebar section headers (emph.), inspector labels |
| Footnote | 10/13 | 400 | 600 | Legal and retention notes |
| Caption 1/2 | 10/13 | 400/500 | 500/600 | Badges, duration chips |

**Concentric radius rule:** outer radius = inner radius + inset.

| Outer | Inset | Inner |
|---|---|---|
| Window/auth card 26 | 8 | toolbar capsule 18 (36px items) |
| Floating panel 18 | 10 | sidebar row 8 |
| Menu 12 | 5 | menu item 7 |
| Card 14 | 4 | thumbnail 10 |
| Toolbar group 18 | 4 | hover pill 14 |
| Segmented track 7 | 2 | thumb 5 |

Sheets (20) and popovers (14) use large padding, so they are treated as separate surfaces and are not made concentric.

---

## 2. Components

### 2.0 Shared rules

- **Focus.** Use `:focus-visible` only.
  - Buttons, cards and rows: `outline: 2px solid var(--px-focus-ring); outline-offset: 2px`.
  - Fields: `border-color: var(--px-focus-ring); box-shadow: 0 0 0 3px var(--px-focus-halo)`.
  - The ring is ≥3:1 on every surface: 3.85 light worst, 3.51 dark worst.
- **Transitions.** Never use `transition: all` or `will-change: all`. Always list properties, for example `transition-property: background-color, box-shadow, transform, opacity`.
  - Shell classes must also set `transition-property`, `outline`, `opacity` and `cursor` themselves, because the legacy globals style every `button` (`transition`, `cursor: pointer`, `:disabled{opacity:.38}`, `:focus-visible{outline…--accent-2}`).
  - Single-class `.px-*` selectors (0,1,0)+ beat `button:disabled` (0,1,1) only if you add a state class or attribute, so write `.px-btn:disabled` and `.px-btn:focus-visible` explicitly.
- **Cursor.** Controls use `cursor: default` (desktop-app feel). Only inline text links use `pointer`.
- **Hit areas.** Any control under 24px gets `::after { content:""; position:absolute; inset: min(0px, calc((100% - var(--px-hit-min)) / 2)) }` (or explicit −2px). Expanded areas must not overlap.
- **Hover** styles are wrapped in `@media (hover: hover)`, so touch devices don't get sticky hovers.
- **Images.** Every thumbnail wrapper gets `::after { inset:0; border-radius:inherit; box-shadow: inset 0 0 0 1px var(--px-image-outline) }`. This is a neutral outline, never tinted.
- **Glass utility:**

  ```css
  .px-glass { background: var(--_mat); -webkit-backdrop-filter: var(--_filter); backdrop-filter: var(--_filter);
    box-shadow: var(--px-inner-highlight), var(--_shadow, var(--px-shadow-2)); }
  [data-px-route="lab"] .px-glass--over-stage { -webkit-backdrop-filter: none; backdrop-filter: none; } /* §0.2 */
  @media (forced-colors: active) { .px-glass { backdrop-filter: none; background: Canvas; border: 1px solid CanvasText; } }
  ```

  - At most 4 blurred surfaces may be visible at once.
  - Glass never samples glass: when the toolbar bar has material, its items drop their own filter (§2.3).
  - Never animate blur radius.
- **Icons (SF Symbol → lucide):**

  | Purpose | SF Symbol | lucide |
  |---|---|---|
  | sidebar | sidebar.left | `PanelLeft` |
  | inspector | sidebar.right / info.circle | `PanelRight` / `Info` |
  | history | clock.arrow.circlepath | `History` |
  | search | magnifyingglass | `Search` |
  | add | plus | `Plus` |
  | more | ellipsis | `Ellipsis` |
  | close | xmark | `X` |
  | undo / redo | arrow.uturn.backward / forward | `Undo2` / `Redo2` |
  | share/export | square.and.arrow.up | `Share` |
  | import | square.and.arrow.down | `Import` |
  | home | house | `House` |
  | projects | folder | `FolderClosed` |
  | library | photo.on.rectangle | `Images` |
  | favorite | heart | `Heart` |
  | named version | bookmark | `Bookmark` / `BookmarkCheck` |
  | record | record.circle | `Circle` (filled `--px-system-red`) |
  | warning | exclamationmark.triangle | `TriangleAlert` |
  | error | exclamationmark.circle | `CircleAlert` |
  | done | checkmark | `Check` |
  | offline | icloud.slash | `CloudOff` |
  | Organ Lab | — | `Shapes` |
  | Tissue Lab | — | `Layers` |
  | Fat Lab | — | `Droplet` |
  | Blood Lab | — | `Droplets` |
  | Physics Lab | — | `Atom` |
  | grid / list | — | `LayoutGrid` / `List` |
  | sort | — | `ArrowUpDown` |
  | pop-up chevrons | chevron.up.chevron.down | `ChevronsUpDown` |

### 2.1 App window layout

```
┌─[8]┬────────── sidebar 240 (floating glass, r18) ───────┬─ toolbar 52 (spans content + inspector) ─────────────────┐
│    │ VISCERA                         [◧]                │ Title                     [center]         [groups…] [⌕] │
│    │ Home · Projects · Library · Imports               ├──────────────────────────────────────────┬───────────────┤
│    │ LABS ▸ …                                          │ content (scrolls under the toolbar)       │ inspector 280 │
│    │ …                                                 │                                          │ (solid, edge- │
│    │ [avatar] Name · Pro · 3.2 of 50 GB                │                                          │  to-edge)     │
└─[8]┴────────────────────────────────────────────────────┴──────────────────────────────────────────┴───────────────┘
```

```css
.px-app { position: relative; height: 100dvh; overflow: hidden; background: var(--px-bg-content);
  display: grid; grid-template-rows: var(--px-toolbar-h) minmax(0, 1fr);
  grid-template-columns: var(--_sb, calc(var(--px-sidebar-w) + var(--px-panel-inset))) minmax(0, 1fr) var(--_insp, 0px);
  transition: grid-template-columns var(--px-dur-slow) var(--px-ease-emphasized); }
.px-app[data-sidebar="hidden"] { --_sb: 0px; }
.px-app[data-inspector="shown"] { --_insp: var(--px-inspector-w); }
.px-sidebar   { grid-area: 1 / 1 / -1 / 2; margin: var(--px-panel-inset) 0 var(--px-panel-inset) var(--px-panel-inset); z-index: var(--px-z-sidebar); }
.px-toolbar   { grid-area: 1 / 2 / 2 / -1; z-index: var(--px-z-toolbar); }
.px-content   { grid-area: 1 / 2 / -1 / 3; overflow: auto; padding-top: var(--px-toolbar-h); scroll-padding-top: var(--px-toolbar-h); overscroll-behavior: contain; }
.px-inspector { grid-area: 2 / 3 / -1 / -1; border-left: var(--px-hairline) solid var(--px-separator); background: var(--px-bg-window); overflow: auto; }
/* Lab routes: the canvas never sits under the toolbar and never reflows when the sidebar toggles */
[data-px-route="lab"] .px-app { --_sb: 0px; }
[data-px-route="lab"] .px-content { grid-row: 2; padding-top: 0; overflow: hidden; }
[data-px-route="lab"] .px-sidebar { position: absolute; inset: calc(var(--px-toolbar-h) + 8px) auto 8px 8px; width: var(--px-sidebar-w); --_mat: var(--px-mat-sidebar-solid); }
```

**Breakpoints:**

| Width | Behaviour |
|---|---|
| ≥ 1280 | Full three columns. Inspector is shown by default in Library and Imports. |
| 900–1279 | The inspector becomes a floating panel: right/bottom inset 8, radius 18, solid material, `--px-shadow-4`. Hidden by default. |
| < 900 | The sidebar becomes an overlay: solid material, scrim `--px-mat-scrim`, background `inert`, Esc or scrim click closes. The search field collapses to an icon button that expands into a field. |
| < 600 | Content padding 16, minimum tile 140, sheets become bottom sheets (top radius 20). Labs show the notice "VISCERA labs work best on a larger display" but stay usable. |

The inspector is solid on the web because there's no desktop behind a browser window. Tahoe's "edge-to-edge inspector glass" would only sample a flat colour.

### 2.2 Sidebar

**Panel.**

- Width `--px-sidebar-w`: 240 by default, resizable 220–260, double-click the edge to reset. The value is persisted in `localStorage` inside try/catch.
- Radius 18, `--_mat: var(--px-mat-sidebar)`, `--_filter: var(--px-mat-sidebar-filter)`, `--_shadow: var(--px-shadow-4)`.
- Padding `0 10px 10px`. Flex column.
- The resize handle is 6px wide on the trailing edge (`cursor: col-resize`), with `role="separator"` + `aria-valuenow`, and arrow keys move it ±8px.

**Header row (52px, aligned with the toolbar).**

- 20px brand mark plus the "VISCERA" wordmark (13/16 semibold, letter-spacing .08em, `--px-label`). Clicking it goes Home.
- Trailing: a 28×28 plain icon button `PanelLeft` (tooltip "Hide Sidebar ⌃⌘S").

**Structure.** Two levels at most, per HIG.

```
Home                (House)
Projects            (FolderClosed)        24
Library             (Images)
Imports             (Import)
LABS                                       ← section header
  Organ Lab         (Shapes)          ›
  Tissue Lab        (Layers)          ⌄   ← expanded: ≤5 recent projects of that lab
     Liver Capsule Study
     Colon Mucosa Walkthrough
  Fat Lab · Blood Lab · Physics Lab
PINNED (only if the user pinned projects)
(flex spacer)
[avatar 28] Daniil Emtsev               ⋯
            Pro · 3.2 of 50 GB
```

**Metrics.**

| Part | Spec |
|---|---|
| Row | Height `--px-sidebar-row-h` (28), radius 8, padding `0 8px`, gap 8, icon 16 in `--px-accent`, label Body in `--px-label`. |
| Trailing count | Subheadline, `.px-num`, `--px-label-secondary`, as plain text (like Mail counts, not pills). |
| Nested row | Padding-left 32, no icon, Body label. |
| Disclosure | 10px chevron at the trailing edge, rotating 90° (`--px-dur-fast` `--px-ease-out`). Clicking the chevron toggles; clicking the row navigates to the lab landing page. |
| Section header | Height 28, Subheadline emphasized (11/14 600) in `--px-label-secondary`, sentence/title case (not uppercase in macOS 11+), margin-top 12. A collapse chevron appears on hover or focus. |
| Footer | 48px account row (§2.16). It stays above the bottom edge, and a browser viewport bottom is always visible, so the HIG "bottom of sidebar" caveat doesn't apply. |

**Row states.** The "emphasized" state is a JS flag: `data-active="true"` on `<nav>` after a pointerdown or keydown inside it, and false on pointerdown or focusin elsewhere. Safari doesn't focus links on click, so `:focus-within` isn't enough.

| State | Background | Label/icon |
|---|---|---|
| Rest | none | label / accent |
| Hover | `--px-fill-quaternary` | — |
| Pressed | `--px-fill-tertiary` | — |
| Selected (nav not active) | `--px-selection-unemphasized` | label / accent |
| Selected (nav active) | `--px-selection` | white / white |
| Drop target (dragging a library item) | `--px-accent-tint` + `inset 0 0 0 2px var(--px-accent)` | — |
| Disabled | — | opacity .4 |

**Accessibility.**

- `<nav aria-label="Sidebar">` containing `<ul>` with links (`aria-current="page"` on the selected row).
- Expandable rows have `aria-expanded`.
- Roving tabindex: Tab enters on the selected row, ↑/↓ move, →/← expand or collapse, Home/End, Enter activates.
- Hide/show: `⌃⌘S`. The toggle stays in the toolbar's leading edge while the sidebar is hidden. The sidebar is never hidden by default except in lab routes.

### 2.3 Toolbar (unified, 52px) and toolbar items

**Layout.** `display:flex; align-items:center; gap:8px; height:52px; padding:0 8px 0 var(--px-content-pad-x)`. Left to right:

1. Leading: sidebar toggle (only when hidden) and Back (`ChevronLeft`) when inside a detail view.
2. Title block (`<h1 tabindex="-1">`):
   - title in Title 3 emphasized (15/20 600), ellipsis, max-width 40%;
   - optional subtitle in Subheadline secondary (item count or save status).
3. Flexible spacer.
4. Center control (segmented, or nothing).
5. Flexible spacer.
6. Trailing glass groups (HIG: at most 3 groups; only one prominent action, on the trailing side).

**Background.**

- At rest: transparent.
- When the scroll container's `scrollTop > 0`, set `data-scrolled` (IntersectionObserver on a 1px sentinel). It then gets `background: var(--px-mat-bar); backdrop-filter: var(--px-mat-bar-filter); box-shadow: inset 0 calc(-1 * var(--px-hairline)) 0 var(--px-separator)`, with an opacity transition on a `::before` layer at `--px-dur-fast`. This is the macOS 27 uniform toolbar.
- `.px-toolbar[data-scrolled] .px-glass { backdrop-filter: none; }` (glass never samples glass).

**Items.**

| Item | Size | Visual | States |
|---|---|---|---|
| Group (`.px-tb-group`) | Height 36, padding `0 2px`, radius 18 | Glass: `--_mat: var(--px-mat-toolbar-item)`, `--_filter: var(--px-mat-toolbar-filter)`, `--_shadow: var(--px-shadow-2)` | — |
| Icon button in a group | 36×36, icon 17 | Hover: inner pill `inset 4px`, radius 14, `--px-fill-tertiary` | Pressed: pill `--px-fill-secondary` and icon `scale(.96)` over `--px-dur-press`. Toggled (`aria-pressed=true`): icon `--px-accent` with a persistent pill. Disabled: icon `--px-label-tertiary`. |
| Text button | Height 36, padding `0 14px`, Body medium | Glass group of one | Same as above |
| Prominent action | Height 36, padding `0 16px`, Body semibold, white | `--px-accent-fill` (hover/pressed tokens), radius 18 | One per toolbar |
| Pop-up | Height 36, label + `ChevronsUpDown` 10px | Glass | Opens a menu with the current item checked |
| Segmented (toolbar) | §2.4 toolbar variant | Glass track | — |
| Search | §2.5 toolbar variant | Glass capsule | — |

- **Tooltips:** every icon-only item shows a tooltip with its name and shortcut (§2.12).
- **Overflow:** items carry `data-priority="1|2|3"`. A ResizeObserver moves the lowest priority into a trailing `Ellipsis` "More" menu. Never overflow at ≥1280px. Every toolbar command must also exist in the context menu or the ⌘K palette; the web has no menu bar, but the HIG asks for menu-bar parity.
- **Morphing between toolbar states** (for example, entering version preview) uses the View Transitions API (`view-transition-name` per group), crossfading over `--px-dur-base`. It is skipped under reduced motion.

### 2.4 Segmented control

**Rules.**

- 2–5 segments (HIG: at most 5–7).
- Equal widths; nouns in Title Case.
- Text or icons, never mixed.
- `role="radiogroup"` with `role="radio"` + `aria-checked`. Selection follows focus. ←/→ move, Home/End.

| Variant | Height | Track | Segment | Selected thumb |
|---|---|---|---|---|
| In-content md | 24 | `--px-fill-tertiary`, radius 7, padding 2 | min-width 56, padding `0 10px`, Body | radius 5. Light: `#FFFFFF` + `0 1px 2px rgba(0,0,0,.12), 0 0 0 .5px rgba(0,0,0,.04)`. Dark: `#636366` (label .85 on it = 4.89). |
| In-content lg | 28 | same, radius 9 | Body | radius 7 |
| Toolbar | 36 | Glass capsule (radius 18), padding 4 | height 28, padding `0 12px`, Body | radius 14. Light `rgb(255 255 255 / .9)` + shadow-2; dark `rgb(255 255 255 / .16)`. |

```css
.px-seg { position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr; isolation: isolate; }
.px-seg__thumb { position: absolute; inset-block: 2px; left: 2px; width: calc((100% - 4px) / var(--n));
  transform: translateX(calc(100% * var(--i))); z-index: -1;
  transition: transform var(--px-dur-spring-snappy) var(--px-spring-snappy); }
```

Unselected segments get 1px `--px-separator` dividers, 12px tall, hidden next to the selected segment. The selected label doesn't change weight, so there's no width jitter.

### 2.5 Search field

**Toolbar variant.**

- Height 36, glass capsule (radius 18).
- Width 220 (min 160, max 280; below 900px it collapses to an icon button).
- Padding `0 30px 0 32px`. `Search` icon 15px at left 11 in `--px-label-secondary`.
- Placeholder names the scope: "Search Library", "Search Imports", "Search Projects".
- Clear button: 16px circle (`--px-fill`) with an 8px `X`, at right 8, visible when there's a value.

**In-content variant** (inspector lists): height 24, radius 7, background `--px-fill-tertiary`, no border.

**Behaviour** (HIG: search as you type, suggestions, scope, tokens).

- Results update after 150ms debounce.
- Esc: the first press clears, the second blurs.
- ⌘F focuses and selects.
- ↓ moves into suggestions.
- **Suggestions popover:** width = field width (min 260), 28px rows. Sections are "Recent Searches" (`Clock`), "Suggestions" (tokens, `Tag`) and "Top Hits" (20px thumbnails).
- **Tokens:** typing `kind:`, `lab:`, `source:` or picking a suggestion inserts a chip. Chips are 20px tall, radius 5, background `--px-accent-tint`, text Callout in `--px-accent-text`. Backspace at position 0 removes the last chip.
- **Accessibility:** `role="combobox"`, `aria-expanded`, `aria-controls` pointing at a `listbox`.

### 2.6 Buttons

**Sizes.**

| Size | Height | Font | Padding-x | Radius | Min width | Icon |
|---|---|---|---|---|---|---|
| sm | 20 | Subheadline (11) medium | 8 | 5 | 48 | 12 |
| md (default) | 24 | Body (13) regular | 10 | 7 | 64 | 14 |
| lg | 28 | Body | 14 | capsule | 80 | 15 |
| xl | 36 | Title 3 (15) semibold | 18 | capsule | 120 | 17 |
| auth | 40 | Title 3 semibold | 20 | capsule | 100% | 17 |

The md through mini sizes stay rounded rectangles, for density; lg and xl become capsules. This mirrors macOS 26 AppKit. Compact density and touch heights come from §1.3.

**Variants.** Hover is gated by `hover: hover`. Pressed: lg, xl and auth sizes also get `transform: scale(var(--px-press-scale))` over `--px-dur-press`.

| Variant | Rest | Hover | Pressed | Text |
|---|---|---|---|---|
| plain | transparent | `--px-fill-quaternary` | `--px-fill-tertiary` | `--px-accent-text` (text) or `--px-label-secondary` (icon) |
| bordered | `--px-bg-control` + `--px-shadow-1` + `--px-inner-highlight` | `--px-bg-control-hover` | `--px-bg-control-pressed` | `--px-label` |
| borderedProminent | `--px-accent-fill` + `0 .5px 1px rgba(0,0,0,.15)` + `inset 0 .5px 0 rgba(255,255,255,.18)` | `--px-accent-fill-hover` | `--px-accent-fill-pressed` | white, weight 600 at md |
| destructive | as bordered | as bordered | as bordered | `--px-danger-text` |
| destructiveProminent | `--px-danger-fill` | `--px-danger-fill-hover` | `--px-danger-fill-pressed` | white |
| glass | `.px-glass` with the toolbar material | inner pill | scale .96 | `--px-label` |

**Other states.**

- Disabled: `opacity: .4`, no hover or press. Prefer `aria-disabled="true"` with a tooltip explaining why for keyboard users.
- Loading: a spinner (§2.14) replaces the leading icon, and the label switches to the progressive form ("Saving…", "Signing In…"). `min-width` is locked to the measured width so nothing shifts. `aria-busy="true"`.

**Rules (HIG).**

- One or two prominent buttons per view. Use style, not size, to mark the preferred choice.
- Title Case verbs ("Save Version", "Restore", "Import Files…"). End the label with "…" when it opens another view.
- Never use "OK" except in purely informational alerts.
- In a button row, the default (prominent) button is trailing and Cancel sits to its left. Return triggers the default and Esc triggers Cancel.

```css
.px-btn { --_h: var(--px-ctl-h-md); position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: var(--_h); min-width: 64px; padding: 0 10px; border: 0; border-radius: var(--px-radius-control);
  font: var(--px-fw-regular) var(--px-fs-body)/1 var(--px-font-sans); letter-spacing: var(--px-tr-body);
  color: var(--px-label); background: var(--px-bg-control); box-shadow: var(--px-inner-highlight), var(--px-shadow-1);
  cursor: default; user-select: none; -webkit-user-select: none; opacity: 1;
  transition-property: background-color, box-shadow, color, transform, opacity;
  transition-duration: var(--px-dur-fast); transition-timing-function: var(--px-ease-out); }
.px-btn::after { content: ""; position: absolute; inset: min(0px, calc((var(--_h) - var(--px-hit-min)) / 2)); }
.px-btn:focus-visible { outline: 2px solid var(--px-focus-ring); outline-offset: 2px; }
.px-btn:disabled, .px-btn[aria-disabled="true"] { opacity: .4; pointer-events: none; }
```

### 2.7 Text fields

**Sizes.**

| Size | Height | Font | Padding-x | Radius | Used in |
|---|---|---|---|---|---|
| md | 24 | `--px-fs-input` | 7 | 7 | Inspector |
| lg | 28 | `--px-fs-input` | 9 | 7 | Sheets, popovers |
| auth | 40 | 15px (16px when coarse) | 12 | 10 | Sign-in |

**Visuals.**

- Background `--px-bg-field`, border `var(--px-hairline) solid var(--px-border-control)`, inset shadow `inset 0 .5px 1px rgba(0,0,0,.06)` (light only), caret `--px-accent`.
- Focus: `border-color: var(--px-focus-ring); box-shadow: 0 0 0 3px var(--px-focus-halo)`.

**Labels.** Always visible above the field: Callout (12/15) medium, `--px-label-secondary`, 6px gap. Placeholder text (`--px-placeholder`) is only ever an example ("name@example.com") and never replaces the label (HIG).

**Validation** (HIG timing).

- Email validates on blur. New-password rules validate live. Server errors are shown after submit.
- Invalid state: border `--px-danger`, plus a message below in Subheadline `--px-danger-text` with a 12px `CircleAlert` icon. Set `aria-invalid="true"` and `aria-describedby`.

**Other.**

- Secure fields: trailing 24×24 plain icon button (`Eye`/`EyeOff`, label "Show Password"/"Hide Password"). A Caps Lock indicator (`ArrowBigUp` + tooltip "Caps Lock is on") appears when `event.getModifierState("CapsLock")` is true.
- Truncated values show the full value in a tooltip (HIG expansion tooltip).
- Text areas: `min-height: 3 × line-height + 12px`, vertical resize only.

### 2.8 Checkbox, switch, slider, pop-up button

**Checkbox.**

- 14×14 box, radius 4. Border `var(--px-hairline) solid light-dark(rgba(0,0,0,.28), rgba(255,255,255,.30))`, background `--px-bg-field`.
- Checked: background `--px-accent`, white check stroke 1.75px. Mixed: an 8×2 white bar.
- Label is trailing (HIG), Body, 6px gap. The whole `<label>` is the target, min row height 20 (24 in forms).
- Use checkboxes for hierarchies of settings (indent children 20px; the parent can be mixed).

**Switch** (macOS: only for emphasized or group settings; never in toolbars or status bars).

| Size | Track | Knob |
|---|---|---|
| Regular | 38×22 | 18, inset 2 |
| Small | 30×18 | 14 |
| Mini | 26×15 | 11 |

- Off: track `--px-fill` plus inner ring `inset 0 0 0 var(--px-hairline) rgba(0,0,0,.08)`.
- On: track `--px-accent`.
- Knob: white with `0 1px 2px rgba(0,0,0,.2), 0 0 0 .5px rgba(0,0,0,.04)`, `transform` over `--px-dur-spring-snappy` `--px-spring-snappy`.
- `role="switch"` + `aria-checked`. Space toggles.

**Slider** (used heavily by labs).

- Track 4px, radius 2, `--px-fill-secondary`. The filled part is `--px-accent`.
- With a neutral value (AppKit `neutralValue`), the fill runs from the neutral point to the thumb. Example: Tissue Lab "Pigment Warmth" (−100…+100%) fills from 0.
- Thumb: 20×14 capsule (HIG "narrow lozenge"), white, `--px-shadow-1`. While dragging it scales 1.1 and takes the HUD glass look (Liquid Glass "interactive"); this is skipped under reduced motion.
- Optional tick marks: 1×4px `--px-label-tertiary`, labelling only the minimum and maximum.
- Value readout: trailing Subheadline `.px-num`, plus a tooltip on hover or drag.
- Keyboard: ←/→ step, ⇧+arrow ×10, PageUp/PageDown ×10, Home/End. `aria-valuetext` uses the formatted value ("+12 %", "Neutral").
- Wide ranges add a 52px md numeric field after the slider (HIG: slider plus text field).

**Pop-up button** (mutually exclusive options; at least 5 options instead of radio buttons).

- Prefer a styled native `<select>` in forms. You get the real macOS menu on Mac and free accessibility.
- Closed state: bordered md, label plus a trailing 10px `ChevronsUpDown`, `appearance: none`.
- Use a custom `PxMenu` pop-up only when items need icons or sections. Its menu opens with the checked item.

### 2.9 Media card (Library / Imports / Projects grids)

**Grid.**

- `display:grid; grid-template-columns: repeat(auto-fill, minmax(var(--px-tile-min), 1fr)); gap: 16px 12px; padding: var(--px-content-pad-top) var(--px-content-pad-x) 32px`.
- `--px-tile-min` comes from the zoom slider: 136 / 168 (default) / 208 / 256.
- Date sections get `content-visibility: auto; contain-intrinsic-size: auto 600px`. Put this on sections, never on cards, so the selection ring isn't clipped.

**Card anatomy.**

```
┌ card (padding 4, radius 14) ───────────┐
│ ┌ thumb (1:1, radius 10, cover) ─────┐ │  overlays (HUD material, white):
│ │ [kind]                       [♥]   │ │  top-left kind chip 20×20 circle, icon 12 (only in "All")
│ │                                    │ │  top-right: favorite heart (filled when favorited; outline on hover)
│ │ [4K · PBR]               [0:42]    │ │  bottom-left status chip / progress ring 16; bottom-right duration
│ └────────────────────────────────────┘ │  chips: Caption 2, .px-num, padding 1px 5px, radius 4
│ Liver capsule · wet         (Body, 1 line, ellipsis)
│ Material · Tissue Lab       (Subheadline, secondary, 1 line)
└────────────────────────────────────────┘
```

- Text block padding: `6px 4px 2px`.
- Project cards use a **16:10** thumbnail and a Body title, with the subtitle "Tissue Lab · Edited 2 h ago".
- Recording thumbnails are 1:1 with cover cropping (16:9 when the View ▸ "Aspect Ratio Grid" setting is on).

**States.**

| State | Treatment |
|---|---|
| Hover | Card background `--px-fill-quaternary`. Shows the heart toggle and the `Ellipsis` button (24×24, top-right inside the thumb). Recordings: after a 400ms hover, play a muted preview loop. Skipped under reduced motion or `navigator.connection.saveData`. |
| Selected (grid focused) | Thumb `outline: 3px solid var(--px-accent); outline-offset: 1px`. This stays inside the card's 4px padding and is concentric. |
| Selected (grid unfocused) | Ring colour `--px-system-gray`. |
| Multi-select | Adds a 20px accent check circle (white `Check` 12) at the thumb's top-right. Any selection count > 1 shows it on all selected cards. |
| Focus (keyboard) | Ring plus `box-shadow: 0 0 0 6px var(--px-focus-halo)` on the thumb. |
| Loading | Thumb background is the stored `dominantColor`, or `--px-bg-thumb` plus shimmer. The image fades in (opacity 0→1, `--px-dur-base`). |
| Uploading / processing | Bottom-left 16px determinate ring, plus `aria-busy`. |
| Error | `ImageOff` 24px in `--px-label-tertiary` and the caption "Preview Unavailable". |
| Drag source | `opacity: .5`. The drag ghost is a 64px thumb with a count badge (accent, white Caption 2). |

**Interaction.**

- Click selects. ⌘-click toggles. ⇧-click selects a range.
- Double-click or Enter opens (in the owning lab or viewer). Space opens Quick Look (§3.4).
- Arrows move in two dimensions; columns are computed from `getComputedStyle(grid).gridTemplateColumns`.
- ⌘A selects all. Esc clears.
- `.` toggles favorite (the Photos convention). ⌘⌫ moves to Trash with an Undo toast.
- Right-click, Shift+F10 or the context-menu key opens the context menu:
  Open · Open in ‹Lab› · Quick Look · — · Add to Favorites · Add to Project… · Rename · Duplicate · — · Export… · Copy Link · — · Move to Trash
- **Accessibility:** the grid is `role="listbox" aria-multiselectable="true"`; cards are `role="option" aria-selected`. Hover buttons are `tabindex="-1"` and are reachable via the context menu and shortcuts. The accessible name is "‹title›, ‹kind›, ‹lab›".

### 2.10 Inspector

- Column 280 (resizable 240–360), solid `--px-bg-window`, leading hairline. Scrolls independently; the title row is sticky.
- **Header (44px):** the item name in Title 3 emphasized. It's an editable inline field: double-click or Enter edits, Esc reverts, blur commits.
- **Preview:** 248×186 (4:3), radius 10, image outline. Shapes get an interactive turntable inside one shared mini WebGL renderer for the whole app (never one context per item).
- **Sections:** disclosure headers, 28px, Subheadline emphasized `--px-label-secondary`, collapse state persisted. Sections are separated by a hairline with 12px inset.
- **Rows:** grid `92px 1fr`, gap 8, min-height 20.
  - Labels: Subheadline secondary, left-aligned, truncating.
  - Values: Callout (12/15) `--px-label`. Numbers use `.px-num` and `Intl.NumberFormat`; units are spaced ("182.4 mm").
- **Controls inside:** md size (24); compact density in labs (22).
- **Footer:** sticky, 52px, top hairline, padding 12. Primary action is borderedProminent md full width (e.g., "Open in Tissue Lab"), plus an `Ellipsis` menu button.
- **No selection:** "No Selection" centered (Title 3, `--px-label-tertiary`).
- **Multiple selection:** "3 Items" header, shared fields only, and batch actions.

### 2.11 Sheet and alert

**Sheet.** Use `<dialog class="px-sheet">` opened with `showModal()`. This gives the top layer, native focus containment and the `cancel` event on Esc.

- **Widths:** S 420, M 560, L 720. `max-height: calc(100dvh - 96px)`. Centered; `margin-top: max(48px, 10vh)`.
- **Surface:** radius 20, `.px-glass` with `--_mat: var(--px-mat-sheet)`, `--_filter: var(--px-mat-sheet-filter)`, `--_shadow: var(--px-shadow-5)`.
- **Backdrop:** `::backdrop { background: var(--px-mat-scrim) }` (HIG: the parent is dimmed).
- **Layout:**
  - Header: 52px, padding `0 20px`, title in Title 3 emphasized, left-aligned. An optional close `X` only for non-form sheets.
  - Body: padding `0 20px 20px`, scrolls.
  - Footer: sticky, 60px, top hairline, padding `0 20px`. Tertiary actions (Help, Sign Out) are leading. On the trailing side, the prominent default sits last with Cancel to its left.
- **Grouped form inside:** body background `--px-bg-grouped`. Group boxes use `--px-bg-grouped-row`, radius 10, rows 36px with a hairline between rows inset 12px. Labels Body, values trailing or controls right-aligned.
- **Rules (HIG):** one sheet at a time, never stacked. Done is always paired with Cancel when changes aren't applied live. Sheets don't resize unless the content benefits.
- **Motion:**
  - Enter: opacity 0→1 over `--px-dur-base`, plus transform `translateY(var(--px-motion-distance)) scale(var(--px-motion-scale-from))` → none over `--px-dur-spring-snappy` `--px-spring-snappy`.
  - Exit: opacity over `--px-dur-fast` `--px-ease-in`.
  - Use `@starting-style` together with `transition-behavior: allow-discrete` on `display` and `overlay`.
- **Focus:** initial focus goes to the first field; for confirmations, the safest button. On close, focus returns to the invoker. If the form is dirty, Esc asks "Discard changes?" with Cancel and Discard (destructive).

**Alert** (destructive confirmations and blocking errors only).

- Dialog 300 wide, padding 20, radius 20, sheet material.
- Contents, centered: 48px app or symbol icon; title in Headline (13/16 700); message in Subheadline secondary.
- Buttons: lg (28) capsules, equal width, side by side. Cancel is leading; the action is trailing. A destructive action uses `destructiveProminent` and is not the Return default, so Return maps to Cancel.
- Copy: "Delete “Liver Study”?" / "This project and its 14 versions will be deleted. You can't undo this action." / [Cancel] [Delete].
- No alerts for undoable actions (HIG); use an Undo toast instead.

### 2.12 Popover, menu, context menu, tooltip

**Popover** (`popover="auto"` gives light dismiss, positioned with Floating UI `offset(8)`, `flip()`, `shift({padding: 8})`, `arrow()`).

- Radius 14, padding 12–16, max-width 360.
- Glass with `--px-mat-popover` + `--px-mat-popover-filter` + `--px-shadow-3`.
- Optional 16×8 arrow in the same material.
- Rules (HIG): one at a time, never cascading. Auto-save whatever was edited when it closes on an outside click. Use an explicit Cancel only to discard. Never warn inside a popover.
- Motion: opacity plus `scale(.98→1)` from the anchor side over `--px-dur-fast` `--px-ease-out`; close over 100ms.

**Menu** (`role="menu"`, used for pull-downs, pop-ups, context menus and the account menu).

- **Container:** min-width 200, max-width 320, padding 5, radius 12, popover material, `--px-shadow-3`.
- **Item:**
  - Height `--px-menu-row-h` (24), radius 7, padding `0 10px`.
  - Label Body. Icon column 16px at x=9; when any item in a group has an icon, all items in that group get one (HIG).
  - Shortcut right-aligned in Body `--px-label-secondary`, with symbols in the order ⌃⌥⇧⌘.
  - Submenu `ChevronRight` 10px trailing.
- **Item states:**
  - Highlight (hover or keyboard): background `--px-selection`, label, icon and shortcut white.
  - Disabled: `--px-label-tertiary`, not focusable via arrows.
  - Checked: a `Check` 12 in the leading column.
  - Destructive: label `--px-danger-text` (white when highlighted).
- **Separator and section header:** separator 1px `--px-separator`, margin `5px 10px`. Section header in Subheadline emphasized secondary, padding `6px 10px 2px`.
- **Submenus:** one level, at most about 5 items. Open on 150ms hover or →. Overlap −5px and flip at the edges.
- **Keyboard:** ↑/↓ wrap, Home/End, → and ← for submenus, Return or Space activates, Esc closes and returns focus to the anchor. Type-ahead matches the first item starting with the typed characters within 500ms.
- **Activation feedback:** the chosen item flashes once (two steps over 120ms) before the menu closes, as on macOS. Skipped under reduced motion.
- **Labels:** Title Case, verbs, no articles. Add "…" when more input follows (HIG).

**Tooltip** (`role="tooltip"`, `aria-describedby`).

- Shows after 700ms hover or immediately on keyboard focus. Within 300ms of another tooltip closing, it shows instantly.
- Subheadline text, max-width 240, padding `4px 8px`, radius 6, popover material, `--px-shadow-3`.
- Offset 6 below the anchor. Content: "Version History  ⌥⌘Y".

### 2.13 Toast and HUD

**Toast** (action feedback, optional Undo). Rendered with `popover="manual"` so it sits above dialogs.

- Bottom-center of the content column, 16px above the bottom (in labs, above the viewport HUD row).
- Min-height 36. Radius 18 for a single line, 14 for multiple lines. Max-width 480. Padding `8px 8px 8px 14px`.
- Popover material, `--px-shadow-3`.
- Content: icon 16 (status colour), message Body, action as a plain accent text button ("Undo"), and an optional close `X`.
- **Timing:** 4s, or 8s with an action. Pauses on hover or focus. Errors never auto-dismiss. At most one is visible; others queue.
- **Accessibility:** `role="status"` (polite); errors use `role="alert"`.
- **Motion:** enter `translateY(16px)` → 0 over `--px-dur-spring-bouncy` `--px-spring-bouncy` with opacity over 150ms; exit is a 150ms fade.

**HUD** (brief confirmation, Apple OSD style).

- Centered in the content area, 200px wide, radius 18, padding 20.
- `--px-mat-hud` + `--px-mat-hud-filter`, white text: icon 32 plus label in Body semibold.
- Fades in over 150ms, holds 1.2s, fades out over 300ms. `aria-live="polite"`.
- Used for "Version Saved", "Link Copied" and "Exported".

**Viewport HUD chips** (labs).

- 24px tall, padding `0 8px`, radius 12, HUD material (the only glass allowed over the canvas), Caption 2 `.px-num`.
- Examples: "3840 × 2160 · 60 fps". Recording shows an 8px red dot (pulses at 1 Hz; static under reduced motion) and "REC 0:03".

### 2.14 Progress, spinner, skeleton

| Element | Spec |
|---|---|
| Linear determinate | Track 4px (2px inline in cards), radius 2, `--px-fill-secondary`. Fill `--px-accent`, width transition `--px-dur-base` linear. Optional label above: Subheadline secondary ("Importing 3 of 5 Files…"), with a right-aligned `.px-num` percentage. `role="progressbar" aria-valuenow/min/max`. |
| Linear indeterminate | A 40% bar sliding over 1.4s `--px-ease-in-out`, infinite. Under reduced motion: an opacity pulse (.4↔1, 2s); it still moves, since HIG says to keep indicators moving. |
| Circular determinate | 16 / 20 / 32px, stroke 2 / 2.5 / 3. Track `--px-fill-secondary`, progress `--px-accent`, starting at 12 o'clock and filling clockwise. |
| Spinner | 16 / 20 / 32px. 12 rounded spokes (length 28% of size, width max(1.5px, 8%)), opacity ramping .25→1, `rotate` with `steps(12)` over 1s. Colour `--px-label-secondary`; white on HUDs. No text label (HIG, macOS). Keeps spinning under reduced motion (essential motion). |
| Skeleton | `--px-fill-quaternary` blocks, radius = target radius. Shimmer: `linear-gradient(90deg, transparent, light-dark(rgba(255,255,255,.55), rgba(255,255,255,.06)), transparent)` over 1.5s. Static under reduced motion. Shown after a 150ms delay; once shown, kept at least 300ms. |

Never switch an operation between circular and bar styles midway (HIG).

### 2.15 Empty states

- Centered in the content area, shifted up 8%. Max-width 360.
- Icon 44px in `--px-label-tertiary` (lucide, stroke 1.5).
- Title: Title 2 emphasized, `--px-label`, 12px below the icon.
- Description: Body `--px-label-secondary`, 6px below.
- Action: bordered md (or a prominent one when it's the only path forward), 16px below.
- Copy uses Apple voice: say what's missing and what to do.

| Context | Title | Description | Action |
|---|---|---|---|
| Library | No Items Yet | Shapes, materials and recordings you save from a lab appear here. | Open a Lab ▾ |
| Library filter | No Recordings | Record a run in Physics Lab or Tissue Lab to see it here. | Open Physics Lab |
| Search | No Results for “liver capsule” | Check the spelling or try a new search. | — |
| Favorites | No Favorites | Press . or click ♥ on an item to add it to Favorites. | — |
| Projects | No Projects Yet | Start a project in any lab. Versions are saved as you work. | New Project ▾ |
| Version History | No Versions Yet | Versions are saved as you work. Press ⇧⌘S to save a named version. | — |
| Imports | (drop zone, §3.5) | | |
| Load error | Couldn't Load Library | Check your connection and try again. | Try Again |

### 2.16 Avatar and account menu

**Avatar.**

- Sizes 16 (version rows), 24, 28 (sidebar footer), 64 (Account sheet). Circular, `object-fit: cover`, with `inset 0 0 0 var(--px-hairline) rgba(0,0,0,.10)`.
- Fallback: initials (white, semibold, 40% of the size) on `linear-gradient(180deg, #A5ABB8, #858994)`, like Contacts.

**Sidebar footer row.**

- 48px, radius 8, padding `0 8px`.
- Avatar 28; name in Body medium; subtitle in Subheadline secondary `.px-num`: "Pro · 3.2 of 50 GB" (orange `--px-warning-text` at ≥90%, `--px-danger-text` when full).
- Trailing: sync state icon at 12px. `Check` means synced, the spinner means syncing, and `CloudOff` in `--px-warning` means offline.

**Account menu** (opens upward from the row).

- Header: name in Headline and email in Subheadline secondary.
- Items:
  - Account Settings… ⌘,
  - Storage… (shows the meter)
  - Appearance ▸ (System ✓ / Light / Dark)
  - Keyboard Shortcuts ⌘/
  - Help & Feedback
  - Sign Out
- Separators between groups.

**Guest mode.** In the public static copy, where no auth API is configured, the row reads "Guest · Sign In" and Library and Projects are stored locally in IndexedDB.

---

## 3. Screens

### 3.1 Sign-in and auth flows

**Layout.**

```
                    (subtle gradient or pre-blurred render backdrop)
              ┌──────────────── card 400 × auto (radius 26, padding 32) ────────────────┐
              │                      [ app icon 64, radius 14 ]                          │
              │                       Sign In to VISCERA                     Title 1 emph│
              │       Your projects, library and imports, on every device.   Body sec.  │
              │                                                                (24)      │
              │  [           Continue with Apple            ]   40, pill, white+outline  │
              │  [ G         Continue with Google           ]   40, pill, "outline"      │
              │  ─────────────────── or ───────────────────    (20 above / 20 below)     │
              │  Email                                                                   │
              │  [ name@example.com                     ]       auth field 40            │
              │  Password                              Forgot Password?                  │
              │  [ ••••••••                          👁 ]                                │
              │  [                 Sign In                ]     auth prominent           │
              │  [         Email Me a Sign-In Link        ]     plain accent             │
              │  ──────────────────────────────────────────                              │
              │        New to VISCERA?  Create Account                                    │
              │  By continuing, you agree to the Terms of Use and Privacy Policy. Footnote│
              └──────────────────────────────────────────────────────────────────────────┘
                         © 2026 VISCERA · Privacy · Terms · Status        (Footnote, 16 below)
```

**Backdrop.**

- `.px-auth { min-height:100dvh; display:grid; place-items:center; padding:24px 16px }`
- Background:

  ```css
  radial-gradient(1200px 800px at 15% 10%, light-dark(#FDE8EC, #3A1C24), transparent 60%),
  radial-gradient(1000px 700px at 85% 85%, light-dark(#E3EEFF, #0F2240), transparent 55%),
  light-dark(#F5F5F7, #0B0B0D)
  ```

- Optional photographic layer: a VISCERA render with the blur baked into the file (AVIF, 1600×1000, ≤150 KB, `fetchpriority="low"`), opacity .55 light / .45 dark, under the gradient. Never blur it at runtime.

**Card.**

- `.px-glass` with sheet material and `--px-shadow-6`.
- Width `min(400px, 100vw − 32px)`; padding 24 below 480px wide.

**Vertical rhythm.**

| Between | Gap |
|---|---|
| Icon → title | 16 |
| Title → subtitle | 6 |
| Subtitle → providers | 24 |
| Provider → provider | 10 (Apple requires a margin ≥ 1/10 of height = 4) |
| Providers → divider | 20 |
| Divider → Email label | 20 |
| Label → field | 6 |
| Field → next label | 14 |
| Password → Sign In | 20 |
| Sign In → magic link | 8 |
| → footer | 24 |

**Provider buttons.** Same size and same visual weight for both, which satisfies Apple (no smaller than other buttons, no scrolling to reach it) and Google (at least as prominent as other options).

| | Apple (Sign in with Apple JS) | Google (GIS `renderButton`) |
|---|---|---|
| Label | `data-type="continue"`: "Continue with Apple". Allowed: Sign in / Sign up / Continue with Apple. | `text: "continue_with"` ("Continue with Google") |
| Light appearance | `data-color="white" data-border="true"` (White with outline, for light backgrounds) | `theme: "outline"` (white `#FFFFFF`, stroke `#747775`, text `#1F1F1F`) |
| Dark appearance | `data-color="white" data-border="false"` (White on dark; Black is not allowed on dark) | `theme: "outline"` (white, for parity with Apple white) |
| Size | `data-mode="center-align"`, container 100% × 40px. Width range 130–375, height 30–64; HIG minimum 140×30. | `size: "large"` (40px), `width: 336` (max 400) |
| Shape | `data-border-radius="50"` (capsule; range 0–50) | `shape: "pill"`, `logo_alignment: "center"` |
| Don'ts | Don't redraw the logo or change the title; logo and title stay black/white only. A custom button must use Apple's artwork, title at 43% of height, right margin ≥8% of width. | Never recolour or resize the "G". It stays on a white background. Never write the bare word "Google" as the label. Font is Google Sans Medium 14/20. Custom padding is 12 / 10 / 12px (web). |

Re-render both buttons when the appearance changes; listen to `matchMedia('(prefers-color-scheme: dark)')` and to `data-px-theme`. While a provider popup is open, the form is `aria-busy`. If the user closes the popup, show no error.

**Form fields.**

- Email: `type="email" autocomplete="username webauthn"`. This also offers passkeys through conditional mediation (P1).
- Password: `autocomplete="current-password"`.
- The **Sign In** button is the form's default (Return).
- "Forgot Password?" is a plain accent link in Callout on the trailing side of the Password label row.

**States.**

| State | Presentation |
|---|---|
| Submitting | Button shows the spinner and "Signing In…". Fields are `readonly`; provider buttons and links are disabled. |
| Wrong credentials | A banner above the Email label (radius 10, background `light-dark(#FDECEC, rgba(255,66,69,.14))`, `CircleAlert` 16, Body `--px-danger-text`): "Your email or password is incorrect." The password is cleared and focused, and the email is kept. `role="alert"`. |
| Field errors | Inline: "Enter your email address." / "Enter a valid email address." / "Enter your password." |
| Rate limited | Banner: "Too many attempts. Try again in 4:59." (`.px-num` live countdown). The Sign In button is disabled. |
| Offline | Banner: "You're offline. Connect to the internet to sign in." |
| Session expired (in app) | The same card in a sheet titled "Sign In Again", email prefilled. Work in progress stays queued. |

**Magic link** (replaces the form inside the card; a "‹ Back" plain button sits top-left).

- `Mail` icon at 40px in `--px-accent`.
- Title: "Check Your Email".
- Body: "We sent a sign-in link to d•••@gmail.com. It expires in 15 minutes."
- **Code entry:** "Enter the 6-digit code instead" opens one `<input inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\d{6}">`. It renders as 6 cells, each 40×44 with radius 10 and gap 8, drawn as background segments with `letter-spacing` aligned to the cells. Pasting fills all cells, and the form auto-submits on the 6th digit.
- Footer: "Resend Link" (disabled with "Resend in 0:30") · "Use a Different Email".

**Create account.**

- Title "Create Your Account".
- The same provider buttons; keep the "Continue with…" titles for consistency (HIG).
- Fields:
  - Name (`autocomplete="name"`)
  - Email
  - Password (`autocomplete="new-password"`, `passwordrules="minlength: 10; required: lower; required: upper; required: digit;"`)
- Live checklist under the password: `Check` in `--px-success-text` or a `--px-label-tertiary` dot for "At least 10 characters" and "Uppercase, lowercase and a number". `aria-live="polite"`.
- Checkbox "Send me occasional product updates", unchecked by default.
- Prominent "Create Account".
- Footer: "Already have an account? Sign In".
- Next step: "Verify Your Email" with the code UI above, then Home with a welcome HUD.

**Reset password.**

1. "Reset Your Password" / "Enter the email you use for VISCERA. If an account exists, we'll email you a link." → [Send Link]. The response never reveals whether the account exists.
2. "Check Your Email" (same pattern as the magic link).
3. From the link: "Choose a New Password" with New and Confirm fields, the checklist, and the checkbox "Sign out of other devices" (checked) → [Reset Password].
4. "Password Reset" with a `CircleCheck` in `--px-success`, then [Continue to VISCERA].

### 3.2 Home

```
toolbar:  Home                                                    [⌕ Search]  [+ New Project ▾]
content (padding 20 / 24):
  Start a New Project                                                   (Title 2 emph)
  [◉ Organ Lab ] [◉ Tissue Lab ] [◉ Fat Lab ] [◉ Blood Lab ] [◉ Physics Lab ]
  Recent Projects                                                 Show All ›  (plain accent)
  [16:10 card] [16:10 card] [16:10 card] [16:10 card]
  [16:10 card] [16:10 card] [16:10 card] [16:10 card]                (max 8)
```

**Lab tiles.**

- Grid `repeat(auto-fill, minmax(176px, 1fr))`, gap 12. Tile height 112, radius 14, padding 14, background `--px-bg-grouped`; hover `--px-fill-quaternary`; press scale .98.
- Contents: a 32px circle in `color-mix(in srgb, var(--px-lab-tissue) 16%, transparent)` with a 16px icon in the lab tint; the name in Body emphasized; a description in Subheadline secondary, two lines.

| Lab | Description |
|---|---|
| Organ Lab | Generate and sculpt organ shapes. |
| Tissue Lab | Surface materials, endoscope walkthroughs, 4K capture. |
| Fat Lab | Adipose shape, texture and mechanics. |
| Blood Lab | Bleeding, vessels and optics. |
| Physics Lab | Contact, cutting and calibration runs. |

**New Project.** Clicking a tile creates "Untitled ‹Lab› Project" and opens the editor. The toolbar's "New Project ▾" pull-down (prominent) lists the same labs with icons. Shortcut ⌥⌘N.

**Recent projects.** Grid minimum 220, cards per §2.9 with 16:10 thumbnails.

- The thumbnail is a 640×400 WebP snapshot captured on save. Fallback: a lab-tint gradient plus the lab glyph.
- Context menu: Open · Open in New Tab · Rename · Duplicate · Version History… · Export… · — · Move to Trash.

**Loading:** 5 tile skeletons and 8 card skeletons.

### 3.3 Projects and lab landing

**Projects.**

- Toolbar: "Projects" with subtitle "24 Projects".
- Center: segmented icons [`LayoutGrid` | `List`] (no text).
- Trailing: Sort pop-up ("Date Edited", "Name", "Lab", "Size"; Ascending/Descending), Search, and "New Project ▾".
- **List view** (HIG table):
  - Columns: Name | Lab | Edited | Versions | Size. Rows 28, alternating `--px-bg-content-alt`.
  - Headers: Subheadline emphasized; click to sort, click again to reverse, with an 8px chevron. Columns are resizable.
  - Selection: `--px-selection` with white text when focused, unemphasized otherwise.
- Optional utility row "Recently Deleted" (30-day recovery) at the bottom of the sidebar's Labs section.

**Lab landing** (clicking a lab row).

- Title "Tissue Lab", subtitle "12 Projects".
- Trailing prominent "New Tissue Project".
- Content: a one-line description, then that lab's project grid (the Projects grid filtered by lab).

### 3.4 Library

```
toolbar: Library (sub: "1,284 Items")   [All | Shapes | Materials | Recordings | Favorites]   [▫━━●━━▣] [⌕ Search Library] [ⓘ]
content: sticky date headers "Today" / "This Week" / "October 2026" (Title 2 emph, 44px, bar material when stuck)
         grid of media cards (§2.9)                                    │ inspector 280 (§2.10)
```

**Filter.** The toolbar segmented control (5 segments) is the scope. "Favorites" filters across kinds.

**View menu** (`SlidersHorizontal` button with priority 3; it overflows first):

- Group By: Date / Kind / Lab / None
- Sort By: Date Added / Name / Size
- Aspect Ratio Grid (toggle)
- Show Titles (toggle)

**Zoom.** A slider of 4 steps, 96px wide, with `ImageMinus` and `ImagePlus` icons at its ends. Not bound to ⌘+ / ⌘−.

**Inspector fields by kind.**

| Kind | Fields |
|---|---|
| Shape (with textures) | Organ, Lab, Seed / variant, Vertices, Triangles, Bounds (mm), Texture maps (Albedo / Normal / Roughness, resolution), Created, Source project |
| Material | Tissue region, Lab, Albedo swatch (24px, radius 4, outlined), Roughness, Wet coat, Vessel / Fascia / Adipose coverage, Map resolution (Preview 512 / Native 4096), Variation seed, **Provenance: "Procedural — not measured tissue optics"** (required wording; never imply measured or clinical data) |
| Recording | Duration, Resolution (3840 × 2160), Frame rate, **Capture: "Offline deterministic, 30 fps" or "Live, measured 24.6 fps"** (live cadence is reported separately from offline throughput), Codec, Size, Lab, Experiment parameters (disclosure) |
| All | Tags (token field), Used In (project links), Favorite toggle |

Footer primary: "Open in ‹Lab›".

**Quick Look** (Space).

- `<dialog>` up to 960×640 (90vw / 85dvh), radius 20, sheet material.
- 44px header: title in Title 3, "Open in ‹Lab›" (bordered md), Share, Close.
- Body shows the image, the video with native controls, or the turntable.
- ←/→ move to the previous or next item. Space or Esc closes. Focus returns to the card.

**Drag and drop.** Drag cards onto a sidebar project row to add them, or into a lab viewport to import into the scene (the lab decides).

### 3.5 Imports

```
toolbar: Imports (sub: "37 Items")      [All | Unity | Blender | Other]      [⌕ Search Imports] [Import… ⌘O]
content:
  ┌ drop strip (64px, dashed, radius 14) ─────────────────────────────────────────────────────┐
  │  ⤓  Drop Unity or Blender exports here — GLB · glTF · OBJ · STL (with .bin, .mtl, textures) │
  └────────────────────────────────────────────────────────────────────────────────────────────┘
  Blender  12  ⌄      (section header, Title 2 emph, count .px-num secondary, collapsible)
  [card][card][card]…
  Unity  4  ⌄
  Other  21  ⌄
```

**Source grouping.** This is deterministic and computed at import time.

- Blender:
  - glTF `asset.generator` matches `/Blender/i` (for example "Khronos glTF Blender I/O v4.2.x");
  - or an OBJ header comment `# Blender v…`;
  - or an ASCII STL header containing "Blender".
- Unity: `asset.generator` matches `/Unity|glTFast|UnityGLTF/i`.
- Everything else is Other.
- Store `source`, `generator` (the raw string) and `generatorVersion`.
- Show the app names as text with neutral glyphs (`Box`). Don't use the Unity or Blender logos.

**Accepted files.** These match the current importer: `.glb, .gltf (+ .bin, textures .png/.jpg/.jpeg), .obj (+ .mtl), .stl`. Multi-file sets are grouped by base name.

- `.fbx`, `.unitypackage` and `.blend` are rejected with a helpful message:
  - "FBX isn't supported yet. In Unity, export glTF with glTFast or UnityGLTF."
  - "Export a .glb from Blender: File ▸ Export ▸ glTF 2.0."

**Drop zone states.**

| State | Treatment |
|---|---|
| Empty page | A large zone, 240px tall, radius 18, `2px dashed var(--px-separator-opaque)`. `Import` icon 40 in tertiary, title "Bring In Your Models" in Title 2 emph, the format line in Subheadline secondary, and an [Import Files…] bordered lg button. |
| File dragged anywhere over the window | A full-content overlay (`--px-z-drop-overlay`, inset 12, radius 18): `--px-accent-tint` background, `2px dashed var(--px-accent)`, and a centered HUD chip "Drop to Import". MIME types are unreliable for .glb, so validate on drop. |
| Unsupported on drop | An error toast naming the files, with the per-format hint above. |

**Import job rows** (top of the section while running).

- Rows 44px: file name in Body, a determinate bar (2px), status in Subheadline.
- Errors show the importer's exact text in `--px-danger-text`, for example "Only triangle surface models are supported." or "OBJ face index is out of bounds."
- Warnings collapse into "2 Warnings ›".

**Detail viewer** (double-click or Enter; navigation stays within Imports).

- Toolbar: ‹ Back, the title (file name), subtitle "Blender 4.2 · Imported Oct 20". Trailing: [Open in Organ Lab ▾], [Add to Library], [ⓘ].
- **Content:** the 3D viewer on `--px-bg-stage`.
  - Bottom-center HUD segmented: [Shaded | Wireframe | Normals].
  - Buttons: Frame (`Focus`) and Turntable (`RotateCw`).
  - Orbit with drag. F frames the model.
- **Inspector** (values from `ImportedModelStats`):

  | Section | Rows |
  |---|---|
  | File | Name; Format ("glTF Binary 2.0"); Size; Source + generator string; Imported date |
  | Geometry | Meshes; Vertices; Triangles (grouped digits); Bounds X × Y × Z — "meters (glTF)" or "units — no physical unit declared" for OBJ/STL, per importer warnings |
  | Materials | Materials; Textures (count and maximum resolution); estimated GPU memory |
  | Warnings | Each as a row: `TriangleAlert` in `--px-warning`, Subheadline |
  | Actions | Re-import…, Download Original, Delete… (alert) |

### 3.6 Project editor chrome, save status and Version History

```
┌ toolbar 52 (dark in labs; solid --px-bg-content-dark, hairline bottom) ─────────────────────────────────────────────┐
│ [◧] [‹]  Liver Capsule Study ⌄      [Surface | Organ | Endoscope]      [Lit Tissue ⇅]  [↶ ↷]  [● Record]  [🕘]  [ⓘ] │
│          Tissue Lab · Saved ✓                                                                                         │
├──────────────────────────────────────────────────────────────────────────────┬──────────────────────────────────────┤
│                    lab viewport (WebGL, lab-owned)                            │ inspector 280–320 (lab controls       │
│                                                   [3840 × 2160 · 60 fps]      │ built with px-ui; §3.6.4)             │
└──────────────────────────────────────────────────────────────────────────────┴──────────────────────────────────────┘
```

#### 3.6.1 Title block and save status

The title is the project name. Clicking it opens a popover (macOS document title menu) containing:

- Name (lg field, rename on Enter)
- Lab
- Location (Projects)
- Last saved "Today at 14:32"
- [Save Version… ⇧⌘S], [Version History… ⌥⌘Y], [Duplicate…], [Export…]

The subtitle shows the save status, always as icon plus text (never colour alone).

| Status | Shown when | Visual |
|---|---|---|
| Edited | Local changes in the debounce window or not yet sent | "‹Lab› · Edited" in secondary |
| Saving… | A request is in flight for >400ms (faster saves skip straight to "Saved" to avoid flicker) | 10px spinner + "Saving…" |
| Saved | Server acknowledged | 10px `Check` + "Saved". The tooltip gives the exact time. |
| Offline | No network; changes queued in IndexedDB | `CloudOff` in `--px-warning` + "Offline — Saved on This Device" |
| Couldn't Save | Retries exhausted (backoff 1, 2, 4, 8, 16s) | `CircleAlert` in `--px-danger` + "Couldn't Save". Clicking opens a popover with the reason, [Try Again] and [Save a Copy…]. |

- **Autosave:** debounce 1.5s after the last edit, with a forced write at least every 30s while editing. ⌘S flushes immediately.
- **`aria-live`:** announce only transitions to Saved after an explicit ⌘S, Offline and Couldn't Save. Never announce every "Saving…".
- **`beforeunload`:** prompt only if the write queue is non-empty.
- **Conflict** (another tab or device): last writer wins. The overwritten state is first stored as an autosave version, and a banner appears: "Updated from another device. View in Version History".

#### 3.6.2 Save Version (⇧⌘S)

- A popover anchored to the title, 300px wide.
- Title "Save Version" (Headline).
- Name field (lg), prefilled "Version 5" and selected.
- Description textarea (3 rows, optional). ⌘⏎ submits from the textarea.
- [Cancel] [Save Version] (default).
- On success: HUD "Version Saved". The new row appears at the top of the panel with a 1s `--px-accent-tint` flash.
- If nothing changed since the last named version, show the footnote "No changes since “Version 4”" and still allow saving.

#### 3.6.3 Version History panel (⌥⌘Y or the `History` toolbar toggle)

**Panel.**

- 320px wide, floating on the right: inset 8 from the toolbar bottom, the window right and the bottom. Radius 18, `--px-shadow-4`.
- In labs it uses the solid `--px-mat-popover-solid` (§0.2) and overlays the lab inspector without resizing the canvas. Elsewhere it uses glass.
- Enter: `translateX(16px)` → 0 with fade, over `--px-dur-spring-snappy`.
- `role="region" aria-label="Version History"`.

```
┌ Version History                          [X] ┐   44px: Headline + close (24×24 plain)
│ [      All      |      Named      ]          │   md segmented, padding 0 12 10
├──────────────────────────────────────────────┤
│ ● Current Version            Edited · now    │   44px; 8px accent dot; Body emph + Subheadline sec
│ Today                                        │   sticky header 28px, Subheadline emph secondary
│ ┌56×42┐ Liver baseline       🔖     14:32   │   named row ≥56px
│ └─────┘ Daniil · “Wet coat tuned for 4K”     │   meta Subheadline secondary, 2-line clamp
│   ›  6 Autosaves                             │   collapsed group row 28px
│ ┌56×42┐ Restored “Version 3”  ↺     11:05   │   restore entries use RotateCcw
│ Yesterday                                    │
│   …                                          │
├──────────────────────────────────────────────┤
│ Autosaves are kept for 30 days. Named        │   Footnote secondary, padding 10 12
│ versions are kept until you delete them.     │
└──────────────────────────────────────────────┘
```

**Rows.**

- **Grouping:** by local day: Today, Yesterday, weekday names for 2–6 days ago, then "October 14" (same year) or "December 3, 2025". Build the labels with `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat`. Times use `{hour:'numeric', minute:'2-digit'}` with `.px-num`.
- **Autosave groups:** autosaves between two named versions collapse into "N Autosaves" (Figma style). When expanded, each is a 28px row aligned with the text column: time in Callout plus "Autosave" in Subheadline secondary. Within 7 days of expiry the row adds "Deletes in 3 days" in `--px-warning-text`.
- **Bookmark** (`Bookmark`/`BookmarkCheck`, Photoshop's "Mark version"):
  - On an autosave, it promotes the autosave to a named version ("Version N") and opens inline rename.
  - On a named version it shows filled in `--px-accent`. Clicking it again asks "Remove Name?" (it will expire under the retention rules).
- **Row menu** (`Ellipsis` on hover/focus, or right-click):
  - Restore This Version
  - Save as Copy…
  - Name This Version… / Rename…
  - Copy Link
  - Delete Version… (owner only, named only, alert)
- **Selection:** a selected row uses `--px-selection` when the panel is active, unemphasized otherwise. ↑/↓ move the selection; the preview follows after a 250ms debounce.

**Preview mode** (a macOS "Browse All Versions" analogue).

- Selecting a version loads it **read-only** in the viewport.
- The toolbar morphs:
  - title: version name;
  - subtitle: "Version from Oct 21, 2026 at 14:32 · Read-Only";
  - trailing: [Save as Copy…] [Restore] (prominent) [Done].
- Holding ⌥ relabels Restore to "Restore a Copy" (macOS).
- The viewport shows a HUD chip "Previewing Version".
- Esc is Done. ⌘⏎ restores.

**Restore.**

- Non-destructive, so there's no alert.
- First a "Before Restore" autosave is created; the restored content then becomes current, and a "Restored “…”" entry is added.
- Toast: "Restored “Liver baseline”." with [Undo].

**Save as Copy.** A sheet "Save as New Project": Name "Liver baseline copy" → [Cancel] [Save]. Then a toast with [Open].

**Version creation.** Data model: `{id, projectId, kind: 'autosave'|'named'|'restore'|'conflict', name?, description?, createdAt, authorId, labId, thumbUrl, bytes, expiresAt|null}`.

- **Autosave checkpoint:** at most every 10 minutes of active editing, plus before restore, import overwrite, sign-out and conflict.
- **Thinning** (Time Machine style): keep every checkpoint for 24 hours, then the last one per day until `retentionDays` (30 on Free; plan-configurable).
- **Named versions** never expire and count toward storage.

**Panel states.** Loading shows 6 skeleton rows. Error shows "Couldn't Load Versions" with [Try Again]. Empty follows §2.15.

#### 3.6.4 Tissue Lab adoption map (built in isolation; §5)

| Current control (TissueLab.tsx) | New placement | Component |
|---|---|---|
| View: Surface coupon / Atlas organ · exterior / Endoscope · lumen phantom | Toolbar center | Toolbar segmented: **Surface \| Organ \| Endoscope** (disabled segments keep a tooltip explaining why) |
| Surface study: Lit tissue / Base color / Normal / Roughness | Toolbar trailing | Glass pop-up "Lit Tissue ⇅", with Title Case items |
| Record 4K · 5s | Toolbar trailing | Glass button `Circle` (red) "Record". While recording: pressed state, HUD chip "REC 0:03", and the button label "Recording…" with a determinate ring |
| Tissue region, Map resolution (Preview · 512 / Native 4K · 4096), Import generated PBR… | Inspector ▸ **Tissue** | Pop-ups (md), bordered button "Import PBR Material…" |
| Vessel, Fascia, Adipose coverage, Wet coat | Inspector ▸ **Layers** | Sliders 0–100% with readouts |
| Material variation seed, Pigment warmth/depth (bipolar), Colour/Roughness variation | Inspector ▸ **Variation** | Seed field (md, `.px-num`) plus a `Dices` "New Seed" icon button; neutral-value sliders |
| Lighting: Camera-mounted / Grazing · coupon | Inspector ▸ **Lighting** | md segmented "Camera-Mounted \| Grazing" |
| Lumen seed, New lumen variation, Reset camera, Camera yaw/pitch, Look along path | Inspector ▸ **Camera** (only shown in Endoscope view) | Seed field, sliders (yaw −180…180°, pitch −90…90°), bordered buttons |

The inspector runs in `data-px-density="compact"`. The canvas keeps `tabindex="0"` and the lab's own key handling.

### 3.7 Account sheet (⌘,)

- An M sheet (560). Changes apply immediately, macOS Settings style, so the only footer action is **Done** (prominent, trailing) with **Sign Out** (bordered) leading.
- Header block: avatar 64 (hover overlay "Edit"), name in Title 2 emph, email in Body secondary.

| Group | Rows |
|---|---|
| Profile | Name (lg field) · Email (value + "Change…") · Organization (optional) · Role (pop-up: Researcher, Surgeon, Educator, Student, Developer, Other) |
| Sign-In & Security | Apple ("Connected" with `Check` in `--px-success-text`, or [Connect]) · Google (same) · Password [Change Password…] · Passkeys [Manage…] · Devices "3 signed in" [Review…] |
| Plan & Storage | Plan "Pro · 50 GB" [Change Plan…] · storage meter (below) · [Manage Storage…] |
| Appearance | Appearance (md segmented System \| Light \| Dark) · Glass (Clear \| Regular \| Tinted) · Reduce Transparency (switch; "Uses system setting when off") · footnote "Labs always use Dark appearance." |
| — | "Delete Account…" as a plain `--px-danger-text` button with a Footnote explanation (alert plus typed confirmation) |

**Storage meter.**

- Bar 8px tall, radius 4, segments separated by 1px gaps:
  - Projects `--px-system-blue`
  - Library `--px-system-purple`
  - Imports `--px-system-orange`
  - Recordings `--px-system-pink`
  - Versions `--px-system-gray`
  - Free space `--px-fill-tertiary`
- Above it: "3.2 GB of 50 GB used" in Body emph `.px-num`.
- Below it: a legend of 8px dots plus label and size in Subheadline.
- ≥90%: the headline turns `--px-warning-text` with the message "Storage almost full". 100%: `--px-danger-text`, and new versions pause with a banner in the editor.
- `role="meter"` with `aria-valuetext`.

**Sign out.** With an empty sync queue, sign out immediately and return to sign-in. Otherwise show an alert:

- "Some changes haven't synced."
- "If you sign out now, changes from the last few minutes may be lost."
- [Cancel] [Sign Out] (destructive, because the loss would be unintended).

---

## 4. Interaction

### 4.1 Keyboard shortcuts

**Display.** Show modifiers on Mac as symbols in the order ⌃⌥⇧⌘. Elsewhere use "Ctrl+Alt+Shift+K" style.

**Matching.**

- Match on `event.key` for plain character shortcuts.
- Match on **`event.code`** whenever ⌥/Alt is held, because ⌥S produces "ß" on a Mac.
- Ignore when `event.isComposing` or `keyCode === 229`.
- Ignore repeats for toggles.

**Scopes.**

- **Global** shortcuts fire everywhere, including in text fields: ⌘S, ⇧⌘S, ⌘K, ⌘,.
- **App** shortcuts fire unless focus is in an editable field or inside the lab viewport.
- **Lab** shortcuts are owned by the lab, and the shell never steals single-key shortcuts from it.

| Action | macOS | Windows / Linux | Scope |
|---|---|---|---|
| Save now (flush) | ⌘S | Ctrl+S | Global (preventDefault) |
| Save Version… | ⇧⌘S | Ctrl+Shift+S | Global in editor |
| Save a Copy… | ⌥⇧⌘S | Ctrl+Alt+Shift+S | Editor |
| Version History | ⌥⌘Y | Ctrl+Alt+Y | Editor |
| Restore previewed version | ⌘⏎ | Ctrl+Enter | Version preview |
| Undo / Redo | ⌘Z / ⇧⌘Z | Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y | Editor (native in fields) |
| New Project… | ⌥⌘N | Ctrl+Alt+N | App (⌘N/Ctrl+N is reserved by browsers) |
| Import… | ⌘O | Ctrl+O | App |
| Find (focus search) | ⌘F | Ctrl+F | Home, Projects, Library, Imports (not labs) |
| Go To… / command palette | ⌘K | Ctrl+K | Global |
| Account Settings | ⌘, | Ctrl+, | Global |
| Toggle Sidebar | ⌃⌘S | Ctrl+Alt+S | App |
| Toggle Inspector / Get Info | ⌘I | Ctrl+I | App (⌥⌘I opens DevTools in Chrome) |
| Keyboard Shortcuts | ⌘/ | Ctrl+/ | Global |
| Quick Look | Space | Space | Grid |
| Open | ⏎ or ⌘↓ | Enter | Grid |
| Favorite | . | . | Grid |
| Move to Trash | ⌘⌫ | Delete | Grid (Undo toast) |
| Select All / Clear | ⌘A / Esc | Ctrl+A / Esc | Grid |
| Close popover, sheet, preview; cancel | Esc, ⌘. | Esc | Global |

**Never bind:** ⌘N/T/W/Q, ⌘⇧N/T/W, ⌘Tab, ⌘+/⌘−/⌘0 (zoom), ⇧⌘A (Chrome tab search), or any ⌥⌘ combination that macOS uses for accessibility zoom (⌥⌘8, ⌥⌘=, ⌥⌘−).

**⌘K palette.**

- Dialog 640 wide, 18vh from the top, radius 18, sheet material.
- 48px search field (Title 3).
- Results grouped Projects / Library / Labs / Commands; rows 36.
- ⏎ opens. ⌘⏎ opens in a new tab. It lists every toolbar command (HIG menu-bar parity).

### 4.2 Focus management

- The first focusable element is a "Skip to Content" link, visible on focus as a top-left chip.
- **Landmarks:** `<nav aria-label="Sidebar">`, `<main>` (content), `<aside aria-label="Inspector">`, `role="region"` for Version History. The toolbar is a `<div>` whose buttons are each tab stops, in leading → center → trailing order. Not `role="toolbar"`, because the search field breaks arrow semantics.
- **Route change:** set `document.title` to "Library — VISCERA" and focus the toolbar `<h1 tabindex="-1">`. The sidebar selection then turns unemphasized.
- **Composite widgets** (sidebar list, grid, segmented, menus, version list) use roving tabindex: one tab stop each, arrows inside.
- **Dialogs:** `showModal()` contains focus; on close, focus returns to the invoker. Popovers move focus in only when opened from the keyboard (menus always focus their first item). Tab out of a popover closes it.
- **Lab viewport:** `tabindex="0"` with `aria-label="3D viewport — Tissue Lab"` and `aria-describedby` key help. Tab always leaves the canvas; there is no trap. Esc inside the canvas blurs it to the toolbar title.
- **Focus visibility:** `:focus-visible` only. Never remove outlines without a replacement. In HUDs, which are forced dark, the ring resolves to the dark accent.

### 4.3 Accessibility

- **Contrast:** every text token is ≥4.5:1 and every UI token ≥3:1 on its surfaces (§1.2). The HIG goal of 7:1 for small custom text is met by `--px-label` (≥8.7).
  - Add a CI script that recomputes these pairs from `px-tokens.css` and fails below threshold.
- **Never colour alone:** save status uses icon plus text; selection uses ring plus checkmark (multi); errors use icon plus text; storage segments have a legend with values.
- **Reduce Motion** (token overrides in §1.3): slides become fades, there's no scale, springs become 150ms ease-out, no blur animation, no hover video, no shimmer. Spinners keep spinning (essential).
- **Reduce Transparency:** solid materials via the media query (Chromium) and the manual setting (Safari has no media query).
- **Increase Contrast:** HIG increased-contrast colours, stronger strokes, solid materials.
- **Forced colors:** glass is removed, system colours (`Canvas`, `CanvasText`, `Highlight`) are used, focus rings use `Highlight`, and `forced-color-adjust: none` is set only on thumbnails and colour swatches.
- **Text size:** all type scales with `--ui-text-scale` (80–200%, existing Display Settings), with a 10px floor. Layouts must survive 200% without horizontal scrolling at ≥1280px; long labels truncate with tooltips.
- **Targets:** WCAG 2.2 minimum 24×24 (pseudo-element expansion), macOS default 28 for primary controls, 44 on coarse pointers.
- **Screen readers:**
  - Icon-only buttons get `aria-label` matching the tooltip.
  - Toggles use `aria-pressed`, disclosures `aria-expanded`, the sidebar `aria-current`.
  - Progress uses `role="progressbar"`, meters `role="meter"`.
  - Live regions are polite, except errors (assertive).
- **Language and numbers:** `lang="en"`. All dates and numbers go through `Intl`.

### 4.4 Loading and skeletons

- **Shell first:** the sidebar and toolbar render immediately from cached session data. Content skeletons appear after 150ms and stay at least 300ms.

| Surface | Skeleton |
|---|---|
| Grids | 12 cards (thumb plus two text bars at 60% / 40% width, 10px tall, radius 4) |
| Inspector | Preview block plus 6 rows (label bar 40%, value bar 70%) |
| Version list | 6 rows (thumb plus two bars) |
| Lab load | `React.lazy` boundary inside the content area. Determinate bar for downloads (bytes from `Content-Length`; "Downloading Native 4K Maps — 312 of 840 MB"), then indeterminate for shader compile ("Preparing Renderer…"). Same bar style throughout (no circular↔bar switch); centered, 280px wide. The first-visit shader compile is a known slow path, so the message must not imply an error. |
| Thumbnails | `dominantColor` placeholder plus fade-in. `loading="lazy"`, `decoding="async"`, explicit `width`/`height`. |

- **Optimistic updates:** favorite, rename, tag and move-to-Trash update immediately and revert with an error toast on failure.

### 4.5 Errors and messages

**Voice.** Say what happened, then what to do. Use sentence case for messages and Title Case for buttons. No "Error:" prefix, no blame, and error codes only in a "Details" disclosure.

| Severity | Pattern | Example |
|---|---|---|
| Field | Inline below the field (§2.7) | "Enter a valid email address." |
| Section or content load | Empty-state layout with [Try Again] | "Couldn't Load Library" |
| Background action | Toast that persists until dismissed, with [Try Again] | "Couldn't export “Liver.glb”." |
| Document save | Title status plus popover (§3.6.1) | "Couldn't Save" |
| Blocking | Sheet with a single clear path | "Storage Full": [Manage Storage…] [Upgrade…] |
| Destructive confirmation | Alert (§2.11) | "Delete “Liver Study”?" |
| Renderer | In-viewport overlay on `webglcontextlost`: HUD card "The 3D view stopped responding." with [Reload View]. The project state is preserved. | — |
| Import | Per-file inline, using the importer's exact text | "Mesh contains incomplete triangles." |
| Offline | Title status plus sidebar footer icon. Writes queue locally; no modal. | "Offline — Saved on This Device" |

---

## 5. Build notes (professional isolation)

**Packages and folders.**

- `viscera/packages/px-ui/`, a new package containing:
  - `tokens.css`, `base.css`
  - `components/*.tsx` with one CSS file each: PxButton, PxSegmented, PxSearchField, PxTextField, PxCheckbox, PxSwitch, PxSlider, PxPopUp, PxMenu, PxPopover, PxSheet, PxAlert, PxToast, PxHud, PxProgress, PxSpinner, PxEmptyState, PxAvatar, PxMediaCard, PxInspector, PxSidebar, PxToolbar
  - `hooks/useShortcuts.ts`, `useRovingFocus.ts`, `usePlatform.ts`, `useScrolledEdge.ts`
  - It has no dependency on any lab.
- `viscera/apps/studio/src/shell/`: AppShell, routes (Auth, Home, Projects, Library, Imports, Account), LabHost, version-history and save-queue services.

**LabHost contract.** This is the only coupling between the shell and labs.

```ts
export interface LabProps {
  project: { id: string; name: string; snapshot: unknown | null; readOnly: boolean };
  onSnapshot(snapshot: unknown): void;                  // shell debounces → autosave
  setToolbar(items: ToolbarItemSpec[]): () => void;     // center/trailing lab items
  setInspector(node: React.ReactNode | null): void;     // lab controls rendered in the shell inspector
  density: "compact"; appearance: "dark";
}
```

**Lab rules.**

- Labs import only from `@viscera/px-ui` and their own folders.
- The Tissue Lab still must not import from or change `../fat/`, and its acceptance contract (`tissues/AGENTS.md`: tests, `scripts/tissue_visual_review.mjs`, 4K walkthrough review) applies to any chrome change.
- **Rollout:** shell routes first, with the labs mounted unchanged inside `.px-lab-host`. Then Tissue Lab chrome (§3.6.4) behind `?mode=tissues&shell=1`, then the other labs.

**QA gates for each PR.**

1. Playwright screenshots of every screen in Light, Dark, Increase Contrast, Reduce Transparency and Reduce Motion, at 1440 and 1024 wide.
2. axe-core with zero serious violations.
3. A keyboard-only walkthrough of sign-in → Home → Library → open lab → save version → restore.
4. The contrast script passes.
5. The computed style of every element overlapping the canvas shows `backdrop-filter: none`, except HUD chips.
6. Lab frame time with the shell is within ±2% of the lab standalone (same scene, same seed).
7. Legacy lab screenshots are pixel-identical inside `.px-lab-host`.

---

## Sources

**Apple Human Interface Guidelines:**

- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
- [Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
- [Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls)
- [Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)
- [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
- [Popovers](https://developer.apple.com/design/human-interface-guidelines/popovers)
- [Menus](https://developer.apple.com/design/human-interface-guidelines/menus)
- [Collections](https://developer.apple.com/design/human-interface-guidelines/collections)
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views)
- [Windows](https://developer.apple.com/design/human-interface-guidelines/windows)
- [Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles)
- [Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)
- [Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)
- [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)
- [Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards)
- [Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)
- [Sliders](https://developer.apple.com/design/human-interface-guidelines/sliders)
- [Pop-up buttons](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons)
- [Sign in with Apple](https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple)

**Apple developer documentation, WWDC and newsroom:**

- [Displaying Sign in with Apple buttons on the web](https://developer.apple.com/documentation/signinwithapple/displaying-sign-in-with-apple-buttons-on-the-web)
- [UIKit UI element colors](https://developer.apple.com/documentation/uikit/ui-element-colors)
- [WWDC25: Build an AppKit app with the new design](https://developer.apple.com/videos/play/wwdc2025/310/)
- [Apple Newsroom: Liquid Glass](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)

**Liquid Glass and macOS coverage:**

- [MacRumors: How Liquid Glass is changing in iOS 27](https://macrumors.com/2026/06/10/how-liquid-glass-is-changing-in-ios-27)
- [Zamin: WWDC26 Liquid Glass changes](https://zamin.uz/en/technology/205979-apple-is-making-changes-to-its-controversial-liquid-glass-design.html)
- [MacStories: macOS Tahoe review](https://www.macstories.net/stories/macos-26-tahoe-the-macstories-review/2/)
- [TidBITS: Tahoe window corner radius](https://talk.tidbits.com/t/adjust-tahoe-window-corner-radius/33791)
- [MacMost: Photos organization in macOS Tahoe](https://macmost.com/photos-app-organization-in-macos-tahoe.html)

**Google sign-in:**

- [Sign in with Google Branding Guidelines](https://developers.google.com/identity/branding-guidelines)
- [GIS JavaScript reference](https://developers.google.com/identity/gsi/web/reference/js-reference)

**Version-history patterns:**

- [Adobe: Photoshop on the web, view and restore versions](https://helpx.adobe.com/photoshop/web/get-set-up/learn-the-basics/view-and-restore-document-versions.html)
- [Adobe: Illustrator cloud documents](https://www.adobe.com/learn/illustrator/web/access-edit-cloud-documents)
- [Adobe: Versioning FAQ](https://helpx.adobe.com/creative-cloud/help/versioning-faq.html)
- [Figma: View a file's version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)
- [Apple Support: Browse All Versions on Mac](https://support.apple.com/guide/mac-help/view-and-restore-past-versions-of-documents-mh40710/mac)

**Values from memory or calculation:**

- The Inter dynamic-metrics constants came from memory and were not re-fetched: [rsms.me/inter/dynmetrics](https://rsms.me/inter/dynmetrics/).
- The AppKit semantic sRGB values (label alphas, windowBackground `#ECECEC`/`#323232`, linkColor `#0068DA`/`#419CFF`, and the selection and under-page values) are widely used samplings, not Apple-published constants.
- The spring curves were fitted numerically (critically or under-damped step response).
- Every contrast ratio was computed with the WCAG 2.x formula.