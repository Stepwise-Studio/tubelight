# Tubelight design brief (Expo / React Native)

Tubelight is an office for AI teammates, as a native app. It should feel like a calm, expensive,
well-made messaging app (think iMessage × Linear × Things), not like "an AI product". The teammates
bring the personality (their animated 3D bot faces); the chrome stays quiet.

## Non-negotiables (the "no AI slop" list)

- **No AI clichés.** No sparkle/magic-wand icons, no purple→pink gradients, no decorative glowing
  blobs, no "✨", no emojis in UI copy, no "Unleash / Supercharge / Seamless / Effortless / Your
  AI-powered…", no "Hi there! 👋 How can I help you today?" empty states.
- **No filler.** No stat cards for their own sake, fake charts, lorem ipsum, stock people avatars,
  or "Coming soon" sections.
- **Copy is plain, specific and short.** Sentence case. Buttons say what happens ("Approve and
  send", not "Confirm"). Empty states say what the place is for and give one action. Errors say what
  went wrong and what to do. Read `.agents/skills/better-writing/SKILL.md`.
- **Every state is designed:** loading (skeleton + reveal, never a lone centered spinner for page
  content), empty, error, disabled, long text, 0/1/many items, small phones (360pt wide), large
  phones, both themes, Dynamic Type / font scaling up to ~1.3 without breaking layout.
- **No layout jumps** when data arrives, when streaming text grows, or when the keyboard opens.
- **Native feel.** Native stack transitions and gestures (swipe back on iOS, predictive back on
  Android), haptics on meaningful moments (send, approve, reject, long-press), pull to refresh,
  proper keyboard handling, safe areas, 44pt minimum touch targets.

## Foundations

- **Stack.** Expo SDK 57, Expo Router (file routes in `app/src/app/`), React Native 0.86 (new
  architecture), React 19 + React Compiler, TypeScript. `app/AGENTS.md` says it plainly: Expo changes
  every SDK; check `https://docs.expo.dev/versions/v57.0.0/` or `https://docs.expo.dev/llms.txt`
  before using an Expo API, and always `npx expo install <pkg>`.
- **Motion.** `react-native-reanimated` 4 (+ `react-native-worklets`), `react-native-gesture-handler`.
- **Graphics.** `@shopify/react-native-skia`.
- **Squircles everywhere.** Every rounded surface is a squircle via `react-native-fast-squircle`
  (`SquircleView`, `cornerSmoothing={0.6}`: the exact smoothing Stepwise UI uses on the web). It
  supports borders, shadows and `overflow: 'hidden'`. When a squircle must be drawn in Skia (e.g. a
  border beam around a card), generate the path with `@lisse/core` `generatePath(w, h, { radius,
  smoothing: 0.6 })` so both match. Only pills, dots and avatars may be plain circles. Radius
  scale: 8 (chips, small controls), 12 (inputs, rows, menus), 16 (cards), 20 (sheets' inner
  panels, modals), 28 (bottom sheets). Nested radii are concentric: outer = inner + padding.
  `react-native-fast-squircle` has no web implementation: provide a `.web.tsx` fallback (plain
  `View` with `borderRadius`) so Expo web still renders for quick previews.
- **Stepwise UI look, ported.** The user's own web library (https://ui.stepwise.studio) is the
  visual reference. Its source is at
  `/tmp/claude-1000/-home-akhil-tubelight/175db5f4-74e7-48d9-b016-e352b57b7aa0/scratchpad/web-app-archive/components/stepwise/`
  (button, input, modal, drawer, toast, segment, toggle, chip, select, command, tooltip,
  shimmer-text, dot-grid-loader, …). Port the *design* (surface stack, hairline edges, elevation,
  press wash, sizes, spacing, zinc palette, typography), not the DOM code. Study `button.tsx`'s
  surface-stack comment in particular.
- **libraries.dev** (https://libraries.dev), React Native ports vendored under `app/src/vendor/`
  (MIT, by Jakub Antalik; keep the LICENSE files):
  - `bot-avatars-native`: every teammate's face, always through one `TeammateAvatar` component.
    `state="working"` while that teammate has a live run, `default` otherwise, `sleeping` for a
    teammate idle for a long time if it reads well. A tap makes it hop: keep that delight.
  - `thinking-orbs-native`: the "teammate is thinking" indicator in a thread. Map live states:
    thinking → `working`, tool → `searching` (or `connecting` for handoffs), writing →
    `composing`, waiting for approval → `breathing`.
  - `border-beam-native`: at most one or two places (e.g. the composer while a run is live, a
    pending approval card). Subtle, tube-coloured. Never decorative.
- **Colour.** Zinc neutrals (Tailwind zinc values) + one accent, **tube**: zinc-50 on dark (zinc-900 on light, where
  zinc-50 would vanish; `onTube` flips with it). Frosted glass was tried and dropped (a mounted BlurView keeps Android redrawing every frame and flips look at rest); the tab
  capsule, sheets and menus stay solid `panel` surfaces. (
  ) Tokens (define once in `src/theme/`, light + dark):
  `canvas` (zinc-50 / zinc-950), `panel` (white / ~#18181b), `panel2` (zinc-100 / ~#222226),
  `line` (black 7% / white 7%), `ink` (zinc-900 / zinc-100), `ink2` (zinc-600 / zinc-400),
  `ink3` (zinc-500), `tube` (#18181b light / #fafafa dark), `tubeSoft` (tube at 10%), `danger`, `success`, `warning` (muted, not neon).
  `tube` is only for focus, the active item, live/working, links. A teammate's own `color` appears
  only in its avatar and at most a 10% tint behind its name. Dark is the default; both themes
  must look deliberate. Follow the system setting with an in-app override (System/Light/Dark).
- **Type.** Inter Display (TTF in `app/assets/fonts/`, embedded via the `expo-font` plugin; family
  names `InterDisplay-Regular`, `-Medium`, `-SemiBold`, `-Bold`). Scale: 12 / 13 / 15 (body) / 17 /
  20 / 28 / 34. Weights 400 / 500 / 600. Tight but not cramped letter-spacing on large sizes
  (≈ -0.3 at 28+). `fontVariant: ['tabular-nums']` on every changing number and timestamp.
  Read `.agents/skills/better-typography/SKILL.md`.
- **Icons.** Hugeicons (`@hugeicons/react-native` + `@hugeicons/core-free-icons`, same set as
  Stepwise UI). Stroke 1.5 beside regular text, 2 beside semibold. 18 in rows, 20 in buttons, 24
  in tab bars. One icon library only.
- **Motion tokens** (from transitions.dev; `~/.claude/skills/transitions-dev/SKILL.md` "Motion
  tokens"). Put them in `src/theme/motion.ts` and use them everywhere with Reanimated
  (`withTiming(v, { duration, easing: Easing.bezier(...) })`):
  durations stagger 40 / micro 80 / quick 150 / fast 250 / medium 350 / slow 400 / very-slow 500 ms;
  easings smooth-out `bezier(0.22, 1, 0.36, 1)` (default for surfaces), in-out, out, linear,
  bounce `bezier(0.34, 1.36, 0.64, 1)` (badge pop only); distances 4 / 6 / 8 / 12 / 30; scales
  0.96 (modal, and press), 0.97 (menu), 0.98 (tooltip), 0.99; blur 2 / 3 / 8.
  Springs: `{ duration: 300, dampingRatio: 1 }`-style, bounce 0 (better-ui rule).
  The transitions-dev recipes are CSS, but their *choreography* is the spec: port the ones that
  fit (notification badge + number pop-in for the Approvals count, text states swap for live
  status labels, skeleton reveal, success check after an approval, error shake on invalid input,
  sliding tabs for segmented controls, accordion for tool-call details, avatar group hover →
  press for member stacks, panel reveal for sheets). Apply `.agents/skills/transitions-polish/`
  rules: closes faster than opens, never delay a close, stagger 40ms capped at ~300ms total,
  press scale 0.96, honour Reduce Motion (`useReducedMotion()`).
- **Polish rules.** `.agents/skills/better-ui/` (and its surfaces / animations / enter-exit /
  icons files), `~/.claude/skills/make-interfaces-feel-better/`, `.agents/skills/better-layout/`,
  `.agents/skills/better-accessibility/` (accessibilityLabel/Role on everything interactive,
  VoiceOver/TalkBack order, `accessibilityLiveRegion` / announcements for finished replies).

## Navigation

- Expo Router. Root: auth gate (signed out → `sign-in`). Signed in: bottom tabs
  **Chats**, **Team**, **Approvals** (badge with pending count), **Activity**, **Settings**
  (use `expo-router`'s native tabs if they look right on both platforms, otherwise a custom tab
  bar: blurred `panel` background, hairline top edge, tube-coloured active icon).
- Chats tab: a stack. Chat list (project groups + DMs, like WhatsApp) → thread (`/chat/[threadId]`)
  → project settings / teammate profile. Threads hide the tab bar.
- Team tab: roster → teammate profile/editor; "New teammate" as a modal sheet.
- New project as a modal sheet from the chat list header.
- Connections live under Settings (and are linked from teammate toolkits).
- Deep links: `tubelight://chat/<threadId>` (push notification taps), `tubelight://connections`
  (Composio OAuth return).

## The chat, specifically

- Messages grouped by sender, avatar once per group, day separators, timestamps on long-press or
  a subtle swipe-left reveal (iMessage style). User bubbles right-aligned squircles in `panel2`;
  teammate messages left-aligned with lighter chrome (name + role above the first in a group).
- Inverted `FlatList` (or `FlashList` if already appropriate), paginated 50, stick to bottom only
  when already at bottom, `maintainVisibleContentPosition` so older messages don't jump.
- Markdown in teammate messages (code blocks with copy + horizontal scroll, lists, links). Keep it
  light.
- Live states: the teammate's avatar switches to `working`, a thinking orb + a text-swapped status
  label ("Thinking", "Searching inbox", "Running tests", "Handing off to Tess") appears where the
  reply will be, then the streamed text types into that same slot and becomes the final message
  with no jump (match the DB row by `meta.stream_id`).
- Handoffs render as a slim system row: `Dev → Tess · "run the auth tests"`.
- Approvals render inline as a card: teammate, title, the draft by shape (email: to/subject/body;
  post: text + character count; code: diff/PR fields; otherwise clean key/value rows), buttons
  Approve / Edit / Reject. Edit makes fields editable in place; Reject optionally takes a note.
  After a decision the card collapses to a one-line result with the success check + haptic.
- Proactive posts (events) carry a small "Started by an event: <type>" label, not an alert colour.
- Errors are a quiet inline row with Retry.
- Composer: auto-growing input in a squircle, `@` opens a mention picker above the composer
  (project members, filtered as you type, tap to insert `@handle`), send button that becomes Stop
  while a run is live, keyboard-aware (`react-native-keyboard-controller` if needed, installed via
  `npx expo install`), safe-area aware.
