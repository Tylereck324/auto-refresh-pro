# UI/UX Audit & Unification Plan

**Branch:** `feature/uiux-unification`
**Scope:** Comprehensive pass — unify design system + visual polish + accessibility + information architecture.
**Surfaces:** Popup, Settings (`options.html`), Manage (`manage.html`), injected Overlay (`content.js`).
**Status:** Checkpoint for review. No implementation has started beyond this doc.

This document is the agreed first deliverable. Review/adjust the findings and the planned changes below; once approved I implement in the phase order at the end.

---

## 0. Guiding decisions (locked during grilling)

| Decision | Resolution |
|---|---|
| Objective | Comprehensive: design unification + polish + a11y + IA |
| Visual identity | **Popup's identity wins** — extend it to Settings + Manage |
| CSS architecture | Extract shared **`theme.css`** (tokens + shared components), linked by all 3 pages |
| Change latitude | Open to behavior changes (restructure markup, regroup, update JS wiring, adjust flows/defaults *with rationale*). No feature removal, no refresh-engine/storage-schema changes. |
| Popup IA | Progressive disclosure — interval + Start/Stop visible; Keyword, Options (9), Advanced collapsed |
| A11y bar | WCAG 2.1 **AA** (pragmatic) |
| Verification | Before/after screenshots (4 surfaces) + `npm test` + `npm run lint` |
| Delivery | Audit doc → review → implement |

---

## 1. The core problem: two design systems

The toolbar popup and the two full-page surfaces are built on **divergent token sets**, so they don't read as one product.

| Token | Popup | Settings + Manage |
|---|---|---|
| Background | `#0a0c10` (near-black) | `#0d1117` (GitHub dark) |
| Surface/card | `#111318` / `#191c23` | `#161b22` / `#21262d` |
| Border | `#252830` / `#2e3138` | `#30363d` |
| Accent | `#4f9eff` → `#a78bfa` **gradient** | `#58a6ff` **flat** |
| Success/green | `#34d399` | `#3fb950` |
| Danger/red | `#f87171` | `#f85149` |
| Text | `#e2e8f0` / `#828b9a` / `#b3bac6` | `#c9d1d9` / `#8b949e` |
| Radius | `10px` / `7px` | `8px` |
| Sans font | `'Inter'` | `'DM Sans'` |
| Mono font | `'JetBrains Mono'` | `'DM Mono'` |

**Note on fonts:** none of the four named fonts (Inter, JetBrains Mono, DM Sans, DM Mono) are bundled or `@import`-ed — by design (privacy/offline/no-FOUT). So today everything falls back to the platform system font regardless of the name. The unified theme will name a single consistent sans + mono stack (system-first), so the *fallbacks* match too.

**The overlay** (`content.js`) already uses the popup palette (`rgba(8,10,14,0.97)` bg, `#34d399`/`#f87171`, `#4f9eff`→`#a78bfa` gradient, JetBrains/Inter naming). It is injected as a string into arbitrary host pages and **must stay style-isolated** (it can't link `theme.css`), so it's left as-is structurally and only gets behavior/polish review.

### Plan
- Create **`theme.css`** as the single source of truth: `:root` tokens (popup palette) + shared component classes.
- Settings and Manage re-skin to these tokens. Because their class names differ (`--surface` vs `--card`, `.toggle-slider` vs `.toggle-track`, etc.), this is a real re-theme, not a find/replace.
- Keep the overlay's inline string in sync by hand (it already matches; just confirm exact hex parity).

---

## 2. Shared `theme.css` — proposed contents

**Tokens (`:root`):** all popup tokens, plus a few additions the other pages need:
- Existing: `--bg --card --card2 --border --border2 --accent --accent-g --green --red --yellow --text --text2 --text3 --radius --radius-s`
- Add for parity/AA: `--danger` (alias of `--red`), `--success` (alias of `--green`), a spacing scale (`--sp-1`…`--sp-6`), `--radius-l` (12px, for the big cards on full pages), and `--font-sans` / `--font-mono` stacks.

**Shared components to extract** (currently duplicated/divergent across pages):
- `.toggle` (popup uses `.toggle-track`/`.toggle-thumb`; options/manage use `.toggle-slider`). Unify on **one** markup + CSS. *This touches markup in all three pages and is the largest single change.*
- Buttons: `.btn` base + `.btn-primary` (gradient Start), `.btn-danger` (Stop/Stop-All), `.btn-ghost` (Go/IO/Add). Today these are 6+ separately-styled button classes.
- Inputs: `.input` (text/number/select), `:focus` accent border, `.invalid` state.
- Card: `.card` shell + `.card-title` (full pages) and `.section-head` (popup) reconciled into one labeling style.
- Header/logo block.
- Focus ring rule (already consistent in intent across pages — centralize it).

**Risk:** unifying the toggle markup means editing every toggle in all three HTML files and the JS that reads them. JS reads by `id` on the `<input>`, which we keep — so behavior is preserved; only the surrounding wrapper markup/classes change.

---

## 3. Popup (`popup.html` / `popup.js`)

### Findings
1. **Density / overwhelming.** One 360px column stacks ~20+ controls: interval pills + custom, keyword input + 2 toggles + 5 flags, 9 option cards, advanced panel, actions, footer. No focal point.
2. **Primary action is buried.** Start/Stop sit *below* everything; on a tall popup the user scrolls past all options to act.
3. **Hidden interdependency (your "labels unclear").** Setting a keyword silently disables Monitor / Stop-on-change / Ignore-noise (`.disabled` = `opacity:0.45; pointer-events:none`) and rewrites the Monitor sub-label. The user gets no explanation of *why* the controls greyed out.
4. **Overlapping/ambiguous labels.** "Monitor / Detect changes", "Ignore noise / Skip clocks-counters", "Stop on change / If page changes" are conceptually one feature cluster (change-detection) but presented as three peer cards with terse subs.
5. **Tiny text.** Section heads 10px, opt-sub 10px, kw-flag 11px, hero-stat-label 9px — several below AA-comfortable size.
6. **Advanced panel mixes concerns.** Stop-after, random range, change-sensitivity, and sound settings all live in one flat "Advanced" — some are only relevant when a corresponding toggle is on (random range row already conditionally shows; sound settings always show even with sound off).

### Plan
- **Restructure to progressive disclosure:**
  - Visible on open: header, (hero when active), **Interval** (pills + custom), **Start/Stop moved up** directly under interval.
  - Collapsible sections (using the existing `adv-toggle`/`aria-expanded` pattern, generalized): **Keyword detection**, **Options**, **Advanced**. All collapsed by default; only interval + actions show.
- **Regroup the 9 options** inside the Options section into labeled clusters: *Refresh behavior* (Hard refresh, Overlay, Random, Keep scroll), *Change detection* (Monitor, Ignore noise, Stop on change), *Actions* (Notify, Stop on click). Cluster sub-headers replace the flat 2-col grid wall.
- **Explain the keyword lock:** when keyword is set, show a one-line inline note in the Change-detection cluster ("Disabled while a keyword is set — the keyword drives alerts") instead of silently grey-ing cards.
- **Clarify copy:** tighten sub-labels so the three change-detection toggles read as a group (e.g. Monitor = "Watch page for any change"; Ignore noise = "Skip clocks, ads, counters"; Stop on change = "Stop when the page changes").
- **Advanced relevance:** show sound settings only when a sound option is enabled (mirror the existing random-range conditional pattern).
- Bump sub-AA font sizes (see §6).

---

## 4. Settings (`options.html` / `options.js`)

### Findings
1. **Off-brand** (GitHub palette + DM fonts) — primary unification target.
2. **Logo gradient differs** (`#58a6ff→#3fb950` green-blue vs popup's blue-purple) — re-theme to popup's `--accent-g`.
3. Generally well-structured (cards, autosave note, hotkey recorder). Hotkey recorder UX is good; keep it.
4. Range inputs (`#defSoundVolume`) have no visible value readout.
5. Sound Tone/Repeat/Volume duplicated between popup Advanced and Settings Defaults — acceptable (defaults vs per-run), but copy should make the relationship clear.

### Plan
- Re-skin to `theme.css` tokens + components; swap toggle markup to the unified toggle.
- Re-theme logo gradient and accents.
- Add a numeric readout next to the volume slider.
- Minor copy: label the Defaults sound rows as "default" explicitly (they already mostly do).

---

## 5. Manage (`manage.html` / `manage.js`)

### Findings
1. **Off-brand** — same re-theme need.
2. Solid layout (job cards, auto-start, URL rules, import/export, toast).
3. `theme.css` toast/empty-state can be shared with future surfaces.
4. Form rows wrap on narrow widths (acceptable; verify after re-theme).

### Plan
- Re-skin to `theme.css` tokens + components; unify buttons (`btn-danger`, `btn-add`, `btn-io`, `btn-sm-*` → `.btn` variants) and the toggle.
- Re-theme logo gradient.

---

## 6. Accessibility (target: WCAG 2.1 AA)

### Findings
- **Contrast:** `--text2 #828b9a` on `#0a0c10` ≈ 4.9:1 (ok for normal, **fails** for the many <12px/secondary uses at AA's large-text exemption boundary); verify each usage. 9–11px labels are the main risk.
- **Reduced motion:** `pulse-dot`, `blink`, `fadeIn`, and numerous transitions have **no** `prefers-reduced-motion` guard.
- **Collapsibles:** popup advanced already sets `aria-expanded`; the *new* collapsible sections must do the same and be keyboard-operable (Enter/Space), with `role="button"` or real `<button>`.
- **Tap targets:** toggles are 34×19 / 36×20px — under 24px in one dimension; the clickable label area compensates, but verify ≥24px hit area.
- **Custom buttons:** footer links + adv-toggle use `role="button" tabindex="0"` — confirm Enter/Space handlers (popup.js wires some; audit all).

### Plan
- Centralize a `@media (prefers-reduced-motion: reduce)` block in `theme.css` that neutralizes animations/transitions.
- Raise smallest text: floor body/secondary text at 11px→12px, micro-labels 9px→10px only where decorative; ensure ≥4.5:1 for anything carrying meaning (darken bg or lighten `--text2` as needed).
- Ensure every collapsible is a real `<button>` (or keeps `role`/`aria-expanded` + key handlers) and tab order is logical.
- Verify focus ring visible on all interactive elements (rule exists; confirm coverage after markup changes).

---

## 7. Overlay (`content.js`) — behavior/polish only

### Findings
- Visually on-brand already. Draggable + resizable; clamps to viewport.
- `z-index: 2147483647` (max) — fine.
- Stop button and hint present.

### Plan
- Confirm exact hex parity with `theme.css` tokens (comment-link the values so they don't drift).
- Light polish only: verify hint copy clarity and reduced-motion on its progress-bar transition. No re-theme.

---

## 8. Risks & non-goals

- **Toggle markup unification** is the riskiest change (touches all 3 HTML files + nothing in JS logic since IDs are preserved). Will verify each page after.
- **Non-goals:** no changes to the refresh engine, alarms, storage schema, message protocol, or `validators.js` trust boundary. No feature removal. No new permissions.
- Default *values* unchanged unless a specific copy/UX rationale is noted here (none change silently).

---

## 9. Proposed implementation phases (each its own commit)

1. **`theme.css` foundation** — tokens + shared components; no page wired yet.
2. **Re-theme Settings + Manage** — link `theme.css`, swap to unified tokens/components/toggle, re-theme logos. (Two off-brand pages now on-brand.)
3. **Popup restructure** — progressive disclosure, Start/Stop up, option regrouping, keyword-lock explanation, copy fixes; link `theme.css`.
4. **Accessibility pass** — reduced-motion, contrast/size fixes, collapsible semantics, tap targets, focus coverage; across all surfaces.
5. **Overlay polish** — hex parity + reduced-motion + hint copy.
6. **Verify** — screenshots (popup idle/active, settings, manage, overlay-on-page) + `npm test` + `npm run lint`; open PR.

---

**Awaiting your review.** Tell me what to add/drop/reprioritize. On approval I start at Phase 1.
