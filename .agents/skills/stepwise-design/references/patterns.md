# Patterns

What the Tubelight app settled on, screen by screen, after a lot of iteration with its owner. Each pattern says what
it is, why, and its mobile / desktop form. Use them instead of inventing a new treatment for the same job — the
consistency is a large part of the quality.

Contents: 1 Page shell · 2 Sections & settings · 3 Lists & rows · 4 Choosing things · 5 Status, chips & capsules ·
6 Cards & detail sheets · 7 Buttons & actions · 8 Forms & inputs · 9 Feedback: toasts, confirms, errors ·
10 Loading & empty · 11 Chat & streaming · 12 Images & files · 13 Rich content & data · 14 Floating chrome ·
15 Live states & delight · 16 Copy

## 1. Page shell

- **Mobile:** content scrolls under a floating bottom tab capsule (blurred `panel`, hairline edge, `shadow-float`,
  radius full, inset 12–16px from the edges and above the safe area). Pad scroll content by the capsule's height so
  nothing hides under it. Tab roots get a 34pt large title; pushed pages a compact header (back button, 17pt title,
  hairline below).
- **Desktop:** left sidebar (240–260px) on `canvas` with the same items, active item as a `panel-2` pill with a
  `tube` icon; the page is a centred column on `canvas`. Header: 28pt title + actions on the right, no hairline.
- **Bottom edge:** every scrolling screen fades and progressively blurs into the bottom edge (mobile), so content
  doesn't hard-cut against floating chrome. A gradient from transparent to `canvas` plus a `backdrop-filter: blur()`
  mask is enough on the web.

## 2. Sections & settings

- A page is a stack of **sections, 40px apart**. Each: heading (17/600 `ink`) + optional one-line hint (13 `ink-3`)
  8px above a **group** (a `panel` squircle, radius 16, 1px `line` edge, no shadow).
- Inside a group: rows separated by **hairline dividers inset past the leading icon/avatar** (start at the text).
  Never a gap of `canvas` between rows of one group; never a divider above the first row.
- A row that leads somewhere has a chevron; a row that sets something has its control on the right (toggle, value +
  chevron, chip). Status in a row is a **chip with a dot**, not coloured text.
- Toggles: the label describes the ON state ("Notify me about replies"), the whole row is the hit target. When a
  toggle reveals more options, they appear below with a short **staggered rise** (40ms per row).
- Desktop: the same groups in a 560–640px column; settings with many areas get a left sub-nav (sections as links).

## 3. Lists & rows

- Row: 56px min (mobile), 48px (desktop). Leading 36–40px avatar/icon tile, title 15/500, subtitle 13 `ink-3`
  (one line, ellipsis), trailing meta 12 `ink-3` tabular (times, counts).
- Unread / attention: a small `tube` dot or a count `Badge` — not bold-everything.
- Long-press (mobile) / right-click or `…` (desktop) opens the row's actions.
- Grouped lists (inbox, roster) are flat on `canvas` with inset dividers; settings-like lists sit in a group (§2).
- Empty list: see §10. Never a blank page.

## 4. Choosing things

- **Single choice is radio rows**, not native selects and not a row of buttons. Mobile: the field shows the current
  value + chevron; tapping opens a **bottom sheet of radio rows** (title + optional subtitle each), choosing closes it.
  Desktop: the same rows in a popover anchored to the field. 8+ options → a search field at the top.
- 2–4 mutually exclusive *views* (not settings) → `segment` with the sliding pill.
- **One row per control.** A time is one field with a drum/column picker, not separate hour and minute rows. A date
  range is one field.
- Multi-select → `multiselect` pills, or checkboxes in a sheet/popover.
- Colour choice → `color-swatch` (springing ring).

## 5. Status, chips & capsules

- **Chip** (radius 8, 12–13px label): status (`success` "Connected", `idle` "Off", `warning`, `danger`) with a
  leading dot; filters (selected = `tube-soft` fill + `tube` text). Soft variant by default.
- **Capsule** for things that *happened* in a stream (a reminder set, an automation ran, an approval decided): a
  centred pill on `panel-2`, one line, "**Head:** rest" with the head in 500 weight and the semantic colour for
  approved/rejected. Tapping opens a **detail sheet** with clear hierarchy: status chip → the thing as a 20pt
  headline → details (quietest last). Decided approvals collapse into the same capsule style.
- Counts: `Badge` that pops in (bounce easing, 500ms) and hides at 0.

## 6. Cards & detail sheets

- Card: `panel`, radius 16, padding 16, 1px `line`; raised (`shadow-raised`) only if it's interactive and needs
  lift. Title 17/600, meta 13 `ink-3`, actions at the bottom (primary right on desktop, full-width stack on mobile).
- **Action cards** (approve / reject / answer): full-width in a stream (break out of the message column), title says
  what will happen in a few words ("Install grim (admin)"), the raw payload (command, email body) shown once below in
  a `panel-2` well — never repeat it in the title. Buttons: primary solid "Approve", secondary soft "Edit",
  "Reject". A pending card may carry the single border beam (§15).
- **Detail sheets / dialogs** keep the same hierarchy: chip or overline → headline → body → actions. Sheets (mobile)
  radius 28, grabber, drag down to close; dialogs (desktop) radius 20, Esc and scrim click close.

## 7. Buttons & actions

- One primary (solid) per view. Secondary actions soft or outline; tertiary ghost. Destructive is the danger
  gradient, and its label names the loss ("Delete project").
- Sizes: sm 34px (in rows/cards), md 44px (default), lg 50px (sheet/primary page action). Full-width on mobile
  sheets and empty states; content-width on desktop.
- Icon buttons: 44px target on touch (36 visual is fine on desktop), soft or ghost, `aria-label` + tooltip.
- Loading: the label fades out and a spinner takes its place *in the same box* (no width jump); on finish, a tick.

## 8. Forms & inputs

- Label above (13/500 `ink-2`), field in a `panel-2` squircle (radius 12, 44–48px), hint below (13 `ink-3`).
- Focus: `tube` ring. Error: the field border turns `danger`, a short shake (transitions.dev error shake), and the
  hint becomes the error message ("That handle is taken. Try another."). Validate on blur/submit, not per keystroke.
- Character limits show a count only near the limit. Passwords have an eye toggle with an icon swap.
- Long forms on desktop: one column, max 560px. Unsaved edits on a detail page → a floating **save bar** at the
  bottom ("Save to update X, or discard to keep things as they were." + Discard / Save), not a save button lost at
  the top.

## 9. Feedback: toasts, confirms, errors

- **Toast** for outcomes of an action the user took ("Saved to your photos", "Couldn't close Firefox" + reason).
  Short title, optional one-line body. Success/plain ones leave after ~4s; errors and ones with an action stay until
  dismissed. Swipe to dismiss on mobile.
- **Confirm** before anything irreversible: title = the question ("Delete Ivy?"), body = exactly what is lost,
  confirm button repeats the consequence ("Delete teammate"), destructive styling.
- **Inline errors** in a stream are a quiet row with Retry, not a red banner. A whole-page failure is an empty state
  with "Try again".
- Never surface raw error codes or stack traces; say what failed and what to do.

## 10. Loading & empty

- **Skeletons in the final shape** (avatar circle + two text bars, a card outline), pulsing, then a cross-fade
  reveal into content in the same box (400ms). No spinner for page content; spinners only inside buttons and tiny
  inline waits.
- **Empty state:** small quiet art (an icon or a sleeping avatar, not an illustration pack), a title that says what
  this place is for, one sentence, one action. Lines rise in with a short stagger. E.g. "No automations yet" / "Ask a
  teammate in chat, like 'every morning at 8, brief me on what's new'."

## 11. Chat & streaming

- Grouped by sender: avatar once per group, name + role above the first bubble, 2px between bubbles of a group,
  14px between groups, day separators as small centred captions.
- My bubbles: right, `panel-2` (or `tube` in compact overlays), radius 20 with a 6px "join" corner between bubbles
  of one group. Theirs: left, lighter chrome.
- Streaming text types into the same slot the "thinking" indicator occupied, then becomes the final message with no
  jump. Wide content (tables, charts) makes the whole reply full-width, and prose next to it aligns to the same edges.
- Inline code: small chips (radius 5, `panel-2`, mono 13) that sit on the baseline; long code → code block with copy
  and horizontal scroll.
- Composer floats over the list (no bar behind it): transparent at the top easing into `canvas`, a progressive blur
  along the bottom edge; the pill widens to full width while focused; send becomes Stop while something runs.
  `@mentions` and `/commands` are coloured (`tube`) in the input and in sent bubbles.
- A "jump to latest" round button appears after scrolling up ~1 screen, with a `tube` dot when new messages arrived.
- Desktop: the chat column is 680–720px centred; the composer is that width too; Enter sends, Shift+Enter newline.

## 12. Images & files

- Images stand on their own (not inside a text bubble): radius 20, sized by their real aspect ratio (reserve it
  before load), 1px inset outline, a small round **download** button (Hugeicons `Download03Icon`) in a corner.
  Tap → full-screen viewer on black with pinch / double-tap zoom and pan (desktop: click-to-zoom, wheel/trackpad
  zoom, Esc to close), a close button top-right and a full-width "Save" / "Download" action at the bottom.
- Files: a chip-like row (file-type tile, name, "PDF · 38 KB" in `ink-3`, download icon on the right); tap downloads
  under the file's real name.

## 13. Rich content & data

- Charts, stats, schedules, timelines and tables are drawn only from real data — never decorative. Tables get
  tabular numbers, sticky headers on desktop, and become stacked rows on mobile when columns don't fit.
- A "stats" block: 2–4 big numbers (28/600 tabular) with 13 `ink-3` labels; deltas in `success`/`danger` text, no
  arrows-and-colours overload.
- Analytics that update live (memory, CPU): bars in `tube` on a `panel-2` track, values right-aligned tabular,
  refreshed in place without re-layout.

## 14. Floating chrome

- Floating elements (tab capsule, composer, save bar, jump button) sit above content with `shadow-float`, a hairline
  edge and a blurred translucent `panel` — never a solid full-width bar.
- Keep them clear of safe areas and the keyboard; content pads by their measured height.

## 15. Live states & delight

- Something working: a small thinking orb (≈ 28px, no capsule around it) + a 13pt status label that text-swaps in
  place ("Thinking" → "Searching inbox" → "Writing"), shimmering while active.
- One **border beam** (thin, `tube`, soft bloom) at most one or two places in the whole product: the thing that is
  live right now, or the one pending decision. Hairline width; never on idle content.
- Voice / listening: a glow along the bottom edge that follows the input level; the conversation itself stays as
  normal chat bubbles above it.
- No animated avatars. No confetti. Success = a tick that draws in (500ms) + a light haptic on mobile.

## 16. Copy

- Sentence case everywhere. Names the user chose keep their case.
- Say what happened or will happen, in the user's terms: "Saved to your photos", "Close Firefox?", "Nothing happens
  on the phone until you OK it". Not "Operation completed successfully".
- Hints answer "what is this for?" in one line; skip them when the label already says it.
- Numbers with units and real names ("about 104 a day", "4.0 GB", "Built-in display"), not "N/A" or IDs.
