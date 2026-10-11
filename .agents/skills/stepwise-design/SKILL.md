---
name: stepwise-design
description: Akhil's (Stepwise Studio) design system and taste, as built in the Tubelight app — calm, expensive, quiet chrome; zinc neutrals with one cool accent; Inter Display; squircles; Hugeicons; Stepwise UI components; transitions.dev motion; no AI slop. Use it for ANY UI work in Akhil's projects — building or revamping a web app, a screen, a component, a landing page, a dashboard, a settings page, a chat, a form, a mobile (React Native/Expo) screen — and whenever they ask to make something look like Tubelight or Stepwise, "match our design", "make it look good/premium/polished", fix spacing, colours, type, icons or animations, or choose a UI library. Covers dependencies, tokens, components, patterns, motion, copy and responsive rules for both mobile and desktop.
---

# Stepwise design

The look: a calm, expensive, well-made product (think iMessage × Linear × Things), not "an AI product". Content and
people bring the personality; the chrome stays quiet. Every decision below serves that: fewer colours, softer edges,
less motion, plainer words, and every state designed.

Read this file, then pull in what the task needs:

- `assets/tokens.css` — paste-ready CSS variables (light + dark), type scale, radii, shadows, motion, wired into
  Tailwind v4 `@theme`. Start every web project from it.
- `references/patterns.md` — the patterns Tubelight settled on (lists, settings, pickers, capsules, chat, cards,
  sheets, images, empty/loading/error states), each with its mobile and desktop form. Read before building a screen.
- `references/react-native.md` — the same system for Expo / React Native (libraries, tokens in TS, gotchas).

If these skills are installed, use them for the detailed craft rules; this skill sets the taste they apply to:
`better-ui`, `better-typography`, `better-layout`, `better-colors`, `better-writing`, `better-accessibility`,
`make-interfaces-feel-better`, `transitions-dev`, `transitions-polish`.

## 1. Non-negotiables (the "no AI slop" list)

These are what make a UI read as generic. Avoiding them does more for quality than any flourish.

- No AI clichés: no sparkles/magic-wand icons, no purple→pink gradients, no glowing blobs, no ✨ or emoji in UI copy,
  no "Unleash / Supercharge / Seamless / Effortless / AI-powered", no "Hi there! 👋 How can I help?" empty states.
- No filler: no stat cards for their own sake, fake charts, lorem ipsum, stock avatars, "Coming soon" sections.
- Copy is plain, specific, sentence case. Buttons say what happens ("Approve and send", "Delete teammate"), not
  "Confirm" / "Submit". Empty states say what the place is for and give one action. Errors say what went wrong and
  what to do next. Short: people glance.
- Every state is designed: loading (skeleton in the final shape, never a lone centred spinner for page content),
  empty, error, disabled, long text, 0 / 1 / many items, narrow phones (360px), wide desktops, both themes, text
  scaled up ~1.3×.
- No layout jumps when data arrives, text streams in, images load (reserve their aspect ratio) or the keyboard opens.
- One accent, one icon set, one font family. Restraint is the style.

## 2. Dependencies (web)

Stack the Stepwise UI library expects: **React 19, Tailwind CSS v4, TypeScript**, `@/*` path alias to the project
root. Next.js or Vite both fine.

| Need | Use | Why |
|---|---|---|
| Components | **Stepwise UI** — `npx stepwise-ui add button input toast …` (source lands in `components/stepwise/`) | It *is* this design system on the web: squircles, surface stack, motion already right. Check its list before writing a component (see §6). Index: `https://ui.stepwise.studio/llms.txt`; one component: `https://ui.stepwise.studio/docs/<name>.md` |
| Squircles | `@lisse/react` (Stepwise installs it), smoothing **0.6** | Every rounded surface is a squircle; plain `border-radius` only for pills, dots, avatars |
| Font | **Inter Display** — `npx stepwise-ui add typography`, or self-host the `InterDisplay` woff2 from rsms/inter | Tight, neutral, premium at display sizes |
| Icons | **Hugeicons** — `@hugeicons/react` + `@hugeicons/core-free-icons` | Same set as Stepwise UI. Never mix in Lucide/Heroicons |
| Class merging | `clsx` + `tailwind-merge` (`cn()`), installed by Stepwise | |
| Motion | CSS transitions with the tokens in `assets/tokens.css` first; `motion` (motion/react) only for springs, layout and gesture animations | Most motion here is short and simple; CSS is enough |
| Avatars (people / agents) | Tubelight's own hand-drawn faces (black ink PNGs on transparent, `app/assets/avatars`) on the teammate's colour circle | Friendly, consistent, no stock photos |
| Rare delight | libraries.dev web components (border beam, thinking orbs, voice glow) | At most one or two places in a whole product (see §8) |

Required global CSS (Stepwise is class-based dark mode — without this every `dark:` class silently does nothing):

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));
@import "./tokens.css"; /* from assets/tokens.css */
```

Theme follows the system by default with an in-app override (System / Light / Dark) that toggles `.dark` on
`<html>`. Dark is the hero theme, but both must look deliberate.

## 3. Colour

Zinc neutrals (Tailwind zinc) plus **one accent, `tube`**: the cool cyan-white of a lit fluorescent tube
(sky-600 `#0284c7` on light, because sky-500 fails 3:1 as text on white; sky-500 `#0ea5e9` on dark).

- Surfaces stack by lightness, not by borders: `canvas` (page) → `panel` (cards) → `panel-2` (wells, my message
  bubbles, inputs' fill) → `panel-3` (pressed wells). Edges are hairlines: `line` = 7% black/white.
- Text: `ink` (primary), `ink-2` (secondary), `ink-3` (meta, captions), `ink-4` (placeholders, disabled).
- `tube` is only for: focus rings, the active/selected item, live/working states, links, the one primary emphasis on
  a screen. Never for decoration, never for large fills.
- Semantic colours are muted, not neon: `success`, `warning`, `danger`, each with a `-soft` 8–12% tint for chips and
  callouts.
- Entity colours (a person's or agent's colour) appear only in their avatar and at most a 10% tint behind their name.
- Primary (solid) buttons are near-black on light (zinc-700 → zinc-900 gradient) and white on dark (white → zinc-200),
  not the accent colour. The accent is for state, the solid button for action.

Full values in `assets/tokens.css`.

## 4. Type

Inter Display. Scale **12 / 13 / 15 (body) / 17 / 20 / 28 / 34**; weights **400 / 500 / 600** (700 almost never).

| Role | Size / line | Weight | Tracking |
|---|---|---|---|
| Large title (page) | 34 / 40 | 600 | -0.5px |
| Title | 28 / 33 | 600 | -0.4px |
| Heading (section, sheet title) | 20 / 25 | 600 | -0.3px |
| Headline (row title, card title) | 17 / 22 | 600 | -0.2px |
| Body | 15 / 22 | 400 (500 for emphasis) | -0.1px |
| Label (buttons, field labels) | 13 / 18 | 500 | -0.05px |
| Caption (hints, meta) | 13 / 18 | 400 | 0 |
| Footnote / overline | 12 / 16 | 400 / 500 | 0 / +0.2px |

- Hierarchy comes from size, weight and `ink` level together — e.g. a row: 15/500 `ink` title over 13/400 `ink-3`
  subtitle. Don't make things bold to make them important; make the rest quieter.
- `font-variant-numeric: tabular-nums` on every changing number, count, price, time and timestamp.
- Desktop uses the same scale; there is no "desktop body 16". Give desktop more whitespace, not bigger text.
- Measure: prose columns 60–75 characters (≈ 640–720px).

## 5. Shape, space, elevation

- **Radius scale:** 8 (chips, small controls) · 12 (inputs, rows, menus, inner panels) · 16 (cards) · 20 (dialogs,
  toasts, images) · 28 (bottom sheets) · full (pills, avatars, dots). Buttons: 14 (sm 34px) / 18 (md 44px) /
  20 (lg 50px).
- **Concentric nesting:** outer radius = inner radius + padding. A 12px row inside a card with 4px padding → card 16.
- **Space** in 4px steps: 4, 8, 12, 16, 20, 24, 32, 40, 48. Page gutters 16px (mobile) / 24–32px (desktop).
  Sections 40px apart; a heading sits 8–12px above its group.
- **Surface stack** (Stepwise's recipe, for buttons and raised surfaces):
  1. fill — a subtle top-to-bottom gradient inside the squircle;
  2. edge — a 1px border (`edge` / `--ui-border`);
  3. elevation — a soft shadow *outside* the clip (`--shadow-1` for controls/cards, `--shadow-2` for floating
     things: menus, dialogs, toasts);
  4. wash — a translucent overlay on hover/press (`wash`).
- Flat cards (lists, settings groups) are `panel` + 1px `line` edge, no shadow. Shadows are for things that float.

## 6. Components: reach for Stepwise UI first

`npx stepwise-ui add <name>`. Read `https://ui.stepwise.studio/docs/<name>.md` for its props; when matching an
existing screen, open `https://ui.stepwise.studio/docs/<name>` to see how it actually renders before changing it.

| Need | Stepwise component |
|---|---|
| Actions | `button` (solid · soft · outline · ghost · destructive; sm/md/lg), `glow-button` (one hero CTA at most) |
| Text entry | `input` (name/email/username/password/…), `otp-input`, `qty-input`, `slider`, `time-picker`, `date-picker`, `color-picker` |
| Choosing | `segment` (2–4 views), `radio`, `checkbox`, `toggle`, `select`, `combobox`, `multiselect`, `color-swatch` |
| Containers | `frame` (the base squircle surface for anything custom), `profile-card`, `pricing-card`, `product-card`, `table`, `scroll-area`, `separator`, `accordion` |
| Overlays | `modal` (confirmations), `drawer` (sheets from any edge), `popover`, `dropdown-menu`, `tooltip`, `command` (⌘K) |
| Feedback | `toast`, `spinner` (resolves to tick/cross), `progress`, `dot-grid-loader`, `shimmer-text` (thinking/loading labels) |
| Status & identity | `chip` (6 colours, soft/solid/outline), `avatar` (+ `AvatarGroup`), `kbd` |
| Navigation | `breadcrumbs`, `pagination` |
| Text effects (sparingly) | `fade-text`, `typewriter`, `scramble-text`, `squiggly-underline`, `circle-annotation` |
| Backgrounds (marketing only) | `dotted-grid`, `diagonal-lines`, `zigzag-lines`, `dotted-spotlight` |
| Media | `file-uploader`, `video-player`, `arc-carousel`, `lens-carousel`, `folder` |

When nothing fits, build on `frame` with the tokens so the squircle, edge and fill match. Don't pull in another
component library for one widget.

## 7. Icons

Hugeicons only. Sizes: **16** in small buttons and chips, **18** in rows and inline, **20** in buttons and icon
buttons, **24** in tab bars / sidebars. Stroke **1.5** beside regular text, **2** beside semibold. Icons inherit
`currentColor` (`ink-2` by default, `tube` only when active). Every icon-only button has an `aria-label` (and a
tooltip on desktop). Prefer the specific Hugeicons glyph the product already uses (e.g. `Download03Icon` for
downloads) — consistency over novelty.

## 8. Motion

transitions.dev tokens (`assets/tokens.css`): durations **stagger 40 · micro 80 · quick 150 · fast 250 · medium 350
· slow 400 · very-slow 500 ms**; default easing **smooth-out `cubic-bezier(0.22, 1, 0.36, 1)`**; bounce only for a
badge pop.

- Pick by what moves: press/hover feedback, text and icon swaps 150; dropdowns, popovers, dialogs, tabs sliding,
  accordions 250; drawers/sheets/panels 400 in / 350 out; success checks, badges 500.
- **Closes are faster than opens, and are never delayed.** Exits use ~70% of the entrance duration.
- Press: scale 0.96 + wash, 150ms. Menus enter from scale 0.97, dialogs from 0.96, tooltips 0.98 — never from 0.
- Stagger lists at 40ms per item, capped so the whole sequence ends within ~300ms.
- Springs are critically damped (no bounce) for drags released into place.
- Respect `prefers-reduced-motion`: keep fades, drop movement and scale.
- Delight is rationed: a border beam on the one live/pending thing, a thinking orb while something works, a shimmer
  label while loading. One or two places in a product. Never decorative, never on idle content. No animated avatars.

## 9. Responsive: one design, two postures

Design mobile-first (360px), then let it breathe. Breakpoints: Tailwind defaults (`sm` 640, `md` 768, `lg` 1024,
`xl` 1280).

| Concern | Mobile (< 768) | Desktop (≥ 1024) |
|---|---|---|
| App navigation | Floating bottom tab capsule (blurred `panel`, hairline edge), 4–5 items | Left sidebar 240–260px, `canvas` background, active item `panel-2` pill with `tube` icon; collapses to icons at `md` |
| Page header | Large title (34) scrolling into a compact 17pt bar | 28 title in the content column, actions top-right |
| Content width | Full width, 16px gutters | Centred column: reading/chat 680–720px, forms/settings 560–640px, data views up to 1200px |
| Secondary surfaces | Bottom sheets (`drawer` from bottom, radius 28, drag to close) | Anchored `popover` / `dropdown-menu`, or centred `modal` (radius 20); side `drawer` for detail panes |
| Single choice | Radio rows in a sheet | Same radio rows in a popover; `select` for compact forms |
| Lists & tables | Stacked rows (56px), key value in the subtitle | Real `table` (sticky header, tabular numbers) when there are 3+ comparable columns |
| Hover | None — design pressed states instead | Wash on hover, but only under `@media (hover: hover)`; `cursor: pointer` on clickables |
| Targets | ≥ 44px under `(pointer: coarse)` | 32–36px controls are fine with a mouse |
| Shortcuts | — | ⌘K (`command`), Esc closes overlays, Enter submits, `kbd` hints in tooltips |
| Long-press menus | Long-press → action sheet | Right-click / `…` button → `dropdown-menu` |

Same tokens, same type scale, same components in both; only layout, overlay type and input affordances change.

## 10. Accessibility (part of the look, not an afterthought)

- Contrast ≥ 4.5:1 for text, 3:1 for icons and focus rings (why `tube` is sky-600 on light).
- `:focus-visible` ring: 2px `tube`, 2px offset, following the squircle (Stepwise does this).
- Labels on every input and icon button; announce finished async results (`aria-live="polite"`) and toasts.
- Logical tab order; overlays trap focus and return it on close.
- Respect reduced motion (§8) and text scaling (no fixed-height text containers).

## 11. Before you call a screen done

- [ ] Uses tokens only (no raw hex, no ad-hoc radius/shadow/duration).
- [ ] Squircles on rounded surfaces; radii concentric.
- [ ] One accent, used only for state/focus/links; primary button is solid near-black/white.
- [ ] Hierarchy by size + weight + ink level; numbers tabular.
- [ ] Loading, empty, error, long-text, 0/1/many, both themes, 360px and 1440px all checked.
- [ ] Copy plain and specific; buttons name the outcome; no clichés or emoji.
- [ ] Motion from the token table; closes faster than opens; reduced motion honoured.
- [ ] Hugeicons only, right sizes, labels on icon-only buttons.
- [ ] Mobile: sheets, 44px targets, safe areas, keyboard never covers the field. Desktop: sidebar, column widths,
      hover/focus states, keyboard shortcuts.
