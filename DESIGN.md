---
name: Docker Sandbox Manager
description: A Slate Navy workbench for finding and operating local Compose projects.
colors:
  navy-base: "#0f172a"
  surface: "#191f30"
  surface-raised: "#222b40"
  surface-muted: "#171e31"
  text-primary: "#e8edf6"
  text-muted: "#a6b2c5"
  text-subtle: "#8796ad"
  divider: "hsl(222 30% 24%)"
  divider-soft: "hsla(222, 30%, 24%, 0.62)"
  accent-docker: "#1d63ed"
  accent-wash: "rgba(29, 99, 237, 0.1)"
  accent-selected: "#9fc2ff"
  dock-active-wash: "rgba(29, 99, 237, 0.2)"
  dock-selected: "#b6d0ff"
  accent-action: "#1d63ed"
  accent-action-hover: "#3978f5"
  accent-action-text: "#ffffff"
  status-green: "#63d7a3"
  status-cyan: "#8acde0"
  dashboard-cpu: "#aab4ff"
  dashboard-memory: "#79dcb2"
  status-danger: "#ff8293"
  action-danger: "#f08a94"
  status-warning: "#f1c97a"
  card-wash: "rgba(25, 31, 48, 0.82)"
  control-surface: "rgba(25, 31, 48, 0.9)"
  console-surface: "#171e31"
  console-text: "#d0d1d8"
  light-base: "#f1f4f8"
  light-surface: "#ffffff"
  light-text: "#1c2738"
  light-metric-text: "#20232c"
  light-text-muted: "#5b687b"
  light-text-subtle: "#59677a"
  light-accent: "#2867bd"
  light-green: "#17885e"
  dashboard-cpu-light: "#5866c5"
  dashboard-memory-light: "#21815d"
  dashboard-ports-light: "#26758a"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "27px"
    fontWeight: 620
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "12px"
    lineHeight: 1.55
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 600
  field:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
  log:
    fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  xs: "5px"
  sm: "7px"
  control: "8px"
  md: "10px"
  panel: "12px"
  pill: "999px"
spacing:
  space-1: "8px"
  space-2: "16px"
  space-3: "24px"
  control-gap: "8px"
  panel-inset: "14px"
components:
  button-primary:
    backgroundColor: "{colors.accent-action}"
    textColor: "{colors.accent-action-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    size: "40px"
  button-primary-hover:
    backgroundColor: "{colors.accent-action-hover}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    size: "34px"
  button-danger:
    backgroundColor: "rgba(255, 116, 128, 0.09)"
    textColor: "{colors.action-danger}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    size: "34px"
  input:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.field}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
    size: "34px"
  chip-active:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.accent-selected}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  navigation-dock:
    backgroundColor: "rgba(17, 18, 23, 0.84)"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.panel}"
    padding: "5px"
    size: "50px"
  navigation-dock-active:
    backgroundColor: "{colors.dock-active-wash}"
    textColor: "{colors.dock-selected}"
    rounded: "{rounded.control}"
  project-detail-pane:
    backgroundColor: "rgba(15, 16, 21, 0.9)"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.panel}"
    padding: "14px"
  dashboard-metric:
    backgroundColor: "{colors.card-wash}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.panel}"
    padding: "16px"
    size: "138px"
  log-output:
    backgroundColor: "{colors.navy-base}"
    textColor: "{colors.console-text}"
    typography: "{typography.log}"
    padding: "12px 14px 14px"
  terminal-output:
    backgroundColor: "{colors.navy-base}"
    textColor: "{colors.console-text}"
    rounded: "{rounded.control}"
    padding: "12px"
---

# Design System: Docker Sandbox Manager

## Overview

**Creative North Star: "The Slate Navy Workbench"**

Slate Navy is a local operations workbench for Docker Compose projects: a deep blue-navy canvas, gently lifted navy cards, soft blue-tinted borders, and Docker blue for primary actions and focus. Green and cyan remain reserved for service and metric states. The interface prioritizes scanning and context retention over decoration. Projects sit beside their open service/detail pane, while a compact floating dock switches between Projects and Dashboard. Dark is the initial theme; a light theme is also implemented.

The typography and controls stay compact so project and service status remain easy to scan. On desktop, projects use an asymmetric list-and-detail arrangement; on narrow screens, the detail pane flows below its project and the dock moves to the upper-right reserved header area. This document describes the shipped visual language, not additional product capabilities.

**Key Characteristics:**
- Near-black surfaces with restrained radial light and fine dividers.
- Lavender selection, with green, cyan, amber, and coral reserved for semantic status or metric cues.
- Compact controls and an asymmetric project-to-detail workspace.

## Colors

The default palette pairs deep navy surfaces with Docker blue for active and focused controls. Green and cyan identify service and metric families, while amber and coral communicate caution and errors. CPU and memory sparklines use their own soft indigo and green hues. The optional light theme uses cool paper-like surfaces and darker text; logs and terminal output retain a softened navy console treatment.

### Primary
- **Slate Navy** (`navy-base`): The default page canvas.
- **Docker Blue** (`accent-docker`): Primary actions, focus, and selected navigation.
- **Navy Console** (`console-surface`): A softened, readable surface for logs and terminal output.

### Secondary
- **Quiet Green** (`status-green`): Positive service and memory cues.
- **Cool Cyan** (`status-cyan`): Network/port metric identity.
- **KPI Accents** (`dashboard-cpu`, `dashboard-memory`): CPU and memory sparkline/icon accents; the port KPI uses the cool-cyan role.

### Tertiary
- **Warm Amber** (`status-warning`): Warnings and cautionary details.
- **Soft Error Coral** (`status-danger`): Error log text and severe-state accents.
- **Destructive Coral** (`action-danger`): Destructive action labels.

### Neutral
- **Deep Surface** (`surface`, `surface-raised`, `surface-muted`): Nested controls, raised popovers, and subdued surfaces.
- **Cool White** (`text-primary`): Primary dark-theme text and metric values.
- **Muted Gray** (`text-muted`, `text-subtle`): Supporting copy, captions, and secondary labels.
- **Fine White Dividers** (`divider`, `divider-soft`): Quiet boundaries between regions and controls.
- **Console Ink** (`console-surface`, `console-text`): Dark log/terminal wells and readable output.
- **Light Theme Neutrals** (`light-base`, `light-surface`, `light-text`, `light-metric-text`, `light-text-muted`, `light-text-subtle`): Background, panel, primary text, metric text, and supporting text roles when the user selects light mode.
- **Light Theme Accents** (`light-accent`, `light-green`, `dashboard-cpu-light`, `dashboard-memory-light`, `dashboard-ports-light`): Higher-contrast action, status, and KPI roles used in light mode.

**The Accent-as-State Rule.** Keep Docker blue concentrated on selected, focused, or primary-action states; use green, cyan, amber, and coral for their existing semantic roles rather than as decoration.

## Typography

**Display Font:** Declared Inter-first stack (with ui-sans-serif, system-ui, and platform sans-serif fallbacks)  
**Body Font:** Declared Inter-first stack (with ui-sans-serif and system fallbacks)  
**Label/Mono Font:** JetBrains Mono for logs (bundled through Fontsource); terminal output uses the system monospace stack.

**Character:** Compact, neutral sans-serif typography keeps operational labels and summaries legible without competing with live state. Tabular numerals support quick comparison; monospace is reserved for technical output.

### Hierarchy
- **Display** (weight 620, 27px, line-height 1.15): Screen titles such as Projects and Dashboard.
- **Title** (weight 600, 13px): Project and service names.
- **Body** (12px, line-height 1.55): Supporting descriptions and dashboard explanations.
- **Label** (weight 600, 11px): Compact controls, navigation, and component labels.
- **Metric** (weight 580, 25px): Dashboard KPI readings, using tabular numerals.
- **Log** (11px, line-height 1.7): Log stream text in JetBrains Mono; terminal output shares the compact scale with its system monospace stack.

**The Readable-State Rule.** Keep labels and state text distinct from subdued metadata; do not make operational status depend on color alone.

## Layout

The app frame is capped at 1540px. Desktop content uses 32px side gutters, reduced to 20px below 900px and 16px at 760px and below. An 8px/16px/24px spacing rhythm is reused for compact gaps, card insets, and screen separation; denser control gaps and component insets use the measured values in the token layer.

The Projects view uses a two-column asymmetric grid (42% list / 58% detail, with a 12px column gap). Selecting a project opens an overlay detail pane aligned to the right column; at 760px and below, the project list becomes one column and the detail pane returns to normal flow. The Dashboard lays out three KPI cards in equal columns and stacks them on narrow screens. The desktop navigation dock floats at bottom-center; at the narrow breakpoint it moves to the top-right within the reserved header area and reduces to icon-sized controls.

The top bar stays compact and sticky. Project summaries, filters, and details remain close to the work area; avoid introducing horizontal overflow into the dashboard or split pane.

## Elevation & Depth

Depth comes primarily from tonal surface changes, translucent fills, and fine borders rather than shadows on ordinary project or metric cards. Subtle radial gradients illuminate the dark page without becoming a graphic backdrop. Shadows are reserved for floating UI that must separate from content, such as the navigation dock, popovers, and selection bar; light mode removes the page gradients but keeps the same structural hierarchy.

### Shadow Vocabulary
- **Popover:** `0 14px 36px rgba(0, 0, 0, 0.35)` for menus above the page.
- **Navigation Dock:** `0 12px 32px rgba(0, 0, 0, 0.34)` for the floating switcher.
- **Selection Bar:** `0 16px 40px rgba(0, 0, 0, 0.4)` for batch actions above the dock.

**The Flat-Card Rule.** Keep project, service, and metric cards flat at rest; use borders and tonal layering, not card shadows, to establish their edges.

## Shapes

The shape language is restrained and consistent: controls use softly rounded corners (7–8px), cards and floating panels use 10–12px, and status pills use a full capsule radius (999px). Thin borders carry most of the structure. Filter chips are softly squared rather than pill-shaped; the active chip gets a quiet Docker-blue wash. Clip only output panels and popovers where content or layering requires it.

## Components

### Buttons
- **Character:** Compact, low-chrome actions with a clear primary state.
- **Shape:** Softly rounded (8px).
- **Primary:** Docker-blue fill with white text, 40px minimum height and 15px horizontal padding.
- **Hover / Focus:** Primary fill brightens and lifts by 1px on hover; keyboard focus uses the shared visible outline. Reduce all transition durations for reduced-motion preferences.
- **Quiet:** Transparent at rest with muted text; hover adds a subtle white wash and brighter text. Standard buttons are 34px high with 12px horizontal padding.
- **Semantic actions:** Start and destructive controls use contained green and coral treatments rather than replacing the primary action style.

### Chips
- **Style:** Compact filter chips use a transparent background, muted text, and softly squared corners (7px).
- **State:** Hover raises text contrast; active state uses a Docker-blue-tinted fill and border. Status pills remain capsule-shaped and are a separate status treatment.

### Cards / Containers
- **Corner Style:** Project/service containers use 10–12px corners.
- **Background:** Low-contrast navy surfaces; selected project rows receive a subtle Docker-blue-tinted surface.
- **Shadow Strategy:** Flat at rest; see Elevation & Depth for floating elements.
- **Border:** Fine, translucent dividers; active project selection receives a stronger Docker-blue edge.
- **Internal Padding:** Project rows use 12px 11px; the open detail pane uses 14px, reducing to 11px below 900px.

### Inputs / Fields
- **Style:** Dark translucent field, fine border, compact 11px text, 8px radius, and 7px 10px padding.
- **Focus:** Visible 2px outline with offset; hover strengthens the border slightly.
- **Light Theme:** Fields switch to white surfaces and dark text. Search input stays icon-led with 33px left padding.

### Navigation
- **Style:** A two-item floating dock with a translucent raised surface, 12px outer corners, and two 38px-high controls.
- **Default / Active:** Quiet text at rest; the selected screen gets a Docker-blue-tinted background and text. Desktop labels remain visible.
- **Mobile:** At 760px and below the dock moves to the upper-right reserved header area; controls become 36px square with visually hidden labels and accessible names.

### Project Split Pane
The project list owns the left 42% and the selected project's detail/services occupy the right 58%. The detail pane overlays the second column, scrolls independently, and enters with a short horizontal reveal. On narrow screens the pane becomes an in-flow section after the project list. Preserve the selected edge and quiet fill so the project-detail relationship stays visible.

### Dashboard Metrics
Three equal cards present CPU, memory, and open TCP port metrics, each with its own restrained icon/sparkline accent and a recent sparkline for CPU/memory where readings exist. Dark and light themes use the corresponding higher-contrast metric colors. Values reflect selected services; display the existing empty state when data is unavailable. CPU is summed across container readings and can exceed 100%; memory is the approximate sum reported by Docker. Port availability is TCP-only.

### Terminal and Logs
Both outputs sit in dark, bordered, rounded panels even in light theme. Log lines use JetBrains Mono, muted line numbers, and ANSI semantic colors; the output scrolls within a bounded region. Terminal text uses the system monospace stack, preserves whitespace, and shares the same dark console well. Keep output text readable and allow long content to wrap where the terminal does.

## Do's and Don'ts

### Do:
- **Do** keep Docker blue concentrated on selection, focus, and primary-action states.
- **Do** use fine borders and tonal surfaces before adding shadows to cards.
- **Do** preserve the asymmetric project/detail relationship on desktop and its in-flow mobile form.
- **Do** keep KPI colors paired with their established CPU, memory, and port roles.
- **Do** retain a dark console surface for logs and terminal output in both themes.

### Don't:
- **Don't** replace the deep navy foundation with a bright, high-chroma interface.
- **Don't** add shadows to ordinary project, service, or metric cards.
- **Don't** turn the filter chips into capsules; their active treatment is softly squared.
- **Don't** present unavailable metric readings as real values or imply that port checks cover UDP.
