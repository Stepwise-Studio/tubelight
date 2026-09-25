# Tubelight UI

Native primitives that port Stepwise UI's look (zinc surfaces, hairline edges, soft elevation, press wash)
to React Native. Everything rounded is a squircle (`react-native-fast-squircle`, smoothing 0.6); every
pressable scales to 0.96 and washes on press; every motion uses the transitions.dev tokens.
Import from `@/ui` and `@/theme`. See them all live at `/ui-gallery` (dev screen).

## Theme (`@/theme`)

| Export | What |
|---|---|
| `useTheme()` | `{ c, scheme, preference, setPreference }`. `c` is the palette for the current scheme. |
| `c.*` | `canvas` (screen), `panel` (cards), `panel2` (wells, user bubbles), `panel3`, `line` (hairlines), `edge` (control outlines), `ink`/`ink2`/`ink3`/`ink4` (text), `tube`/`tubeSoft`/`tubeGlow` (accent: focus, active, live, links only), `danger`/`success`/`warning` (+`Soft`), `wash`, `scrim`. |
| `setPreference('system' \| 'light' \| 'dark')` | Persisted in AsyncStorage. Dark is the default when the system is unknown. Use a `Segment` for it in Settings. |
| `type` | Scale: `largeTitle` 34, `title` 28, `heading` 20, `headline` 17, `body`/`bodyMedium` 15, `label`/`caption` 13, `footnote`/`overline` 12, `mono`. |
| `radius` | `sm` 8 (chips) · `md` 12 (inputs, rows, menus) · `lg` 16 (cards) · `xl` 20 (dialogs, toasts) · `sheet` 28. Nest concentrically: outer = inner + padding. |
| `space` | 4pt steps: `space[4]` = 16. |
| `motion` | `duration` (stagger 40, micro 80, quick 150, fast 250, medium 350, slow 400, verySlow 500), `ease` (smoothOut default, inOut, bounce for badges only, …), `distance`, `scale`, `spring` (bounce 0), `timing(d, easing)`, `staggerDelay(i)`. Closes are faster than opens; never delay a close. |

## Primitives

| Component | Use it for | Key props |
|---|---|---|
| `Text` | All text. Font scaling capped at 1.3. | `variant`, `color` (palette key or colour), `tabular` (changing numbers/times), `align` |
| `Icon` | Hugeicons only. 18 in rows, 20 in buttons, 24 in tabs. | `icon`, `size`, `color`, `strokeWidth` (1.5 regular, 2 semibold) |
| `Squircle`, `AnimatedSquircle` | Any rounded surface you build yourself. | View props + `cornerSmoothing` |
| `Press` | Base pressable: squircle + scale 0.96 + wash + optional haptic. | `radius`, `style` (inside the clip), `outerStyle` (margins, shadow), `wash`, `static`, `haptic` |
| `Surface` | Static panel/card. | `tone` (`panel`, `panel2`, …), `radius` (16), `edge`, `elevated`, `padding` |
| `Card` | Pressable Surface. | `Press` props + `tone` |
| `Button` | Actions. Label says what happens ("Approve and send"). | `label`, `variant` (`solid` \| `soft` \| `outline` \| `ghost` \| `destructive`), `size` (`sm` 34 / `md` 44 / `lg` 50), `icon`, `iconPosition`, `loading`, `fullWidth`, `haptic` |
| `IconButton` | Icon-only, 44pt. **`accessibilityLabel` required.** | `icon`, `variant` (`ghost` \| `soft` \| `solid` \| `tube`), `size`, `color` |
| `TextField` | Labelled input. Tube focus ring; `error` turns it red and shakes it (transitions.dev error shake) with an error haptic. | `label`, `hint`, `error`, `secureTextEntry` (eye toggle with icon swap), `multiline`, `showCount` + `maxLength`, `icon`, `inputRef` |
| `SearchField` | Compact search with clear button. | `value`, `onChangeText`, `placeholder` |
| `Chip` | Status or filter pill (radius 8). | `label`, `tone` (`neutral` \| `tube` \| `success` \| `warning` \| `danger`), `dot`, `icon`, `selected`, `onPress` |
| `Segment` | Segmented control with sliding pill (tabs sliding, 250ms). | `value`, `onChange`, `options: [{value, label, count?}]` |
| `Toggle` | Switch; label describes the ON state. Whole row is the target. | `value`, `onChange`, `label`, `description`, `disabled` |
| `Checkbox` | Squircle check; label shares the hit target. | `value`, `onChange`, `label` |
| `ListRow` | Rows (56pt). | `title`, `subtitle`, `icon` or `leading` (avatar), `accessory`, `chevron`, `destructive`, `onPress`, `onLongPress` |
| `SectionHeader`, `Divider` | Group label (overline) and hairline. | `title`, `action` / `inset` |
| `Sheet` | Bottom sheet: floating squircle (28), drag down / scrim tap / Android back to close, rides above the keyboard. Panel reveal 400ms in, 350ms out. | `open`, `onClose`, `title`, children |
| `showMenu({ title?, message?, items })` | Action sheet (long-press menus, overflow `…`). `items: [{label, icon?, destructive?, onPress}]`. | imperative |
| `Dialog` | Centered modal (modal open 250ms from 0.96, close 150ms). | `open`, `onClose`, `title`, `body`, `actions`, children |
| `confirm({ title, body?, confirmLabel, destructive? })` | `await` a yes/no. Confirm label repeats the consequence ("Delete teammate"). | imperative → `Promise<boolean>` |
| `toast({ title, body?, tone?, action? })` | Queued, top of screen, swipe to dismiss. Plain ones leave after 4s; `error` and ones with an `action` stay. Announced to screen readers. | imperative |
| `Skeleton`, `Reveal` | Loading: pulse placeholder, then cross-fade to content in the same box (no lone spinners for page content). | `Skeleton {width, height, radius}`, `Reveal {ready, skeleton}` |
| `EmptyState` | What the place is for + one action. Lines rise in with a short stagger. | `title`, `body`, `art` (e.g. a sleeping `TeammateAvatar`), `action` |
| `Badge` | Notification count; slides + pops in (transitions.dev notification badge), digits pop on change. Hidden at 0. | `count`, `dot`, `max` |
| `TeammateAvatar` | The only way to draw a teammate (libraries.dev bot-avatars). Tap = hop. | `teammate`, `size`, `state` (`default` \| `working` \| `sleeping`), `interactive` (false inside pressable rows), `paused` |
| `AvatarStack` | Project members. | `teammates`, `size`, `max`, `working: Set<id>` |
| `ThinkingIndicator` | Thinking orb (libraries.dev thinking-orbs) + label that text-swaps in place. | `state: LiveState`, `label` |
| `Beam` | libraries.dev border beam, tube-coloured. At most one or two places (live composer, pending approval). | `radius`, `active` |
| `Logo` | Tube + wordmark. `flicker` only on sign-in. | `flicker`, `wordmark`, `scale` |
| `Markdown` | Teammate message bodies: lists, links (in-app browser), code blocks with copy + horizontal scroll. | `value` |
| Motion helpers | `IconSwap` (swapKey), `TextSwap`, `NumberPop`, `SuccessCheck`, `Collapse` + `useFlip` (accordion + chevron), `Rise` (staggered entrance), `useShake`, `usePressFeedback`. | |
| `haptic` | `tap`, `light`, `medium`, `success`, `warning`, `error`. Meaningful moments only. | |
| `Portal` | Render into the root overlay host (used by Sheet/Dialog). | children |

Hosts (`PortalHost`, `MenuHost`, `ConfirmHost`, `ToastHost`) are already mounted in `src/app/_layout.tsx`.

Web: `*.web.tsx` files swap Skia/native-only pieces (squircle → radius, bot-avatars/thinking-orbs → their web packages, beam → a hairline) so Expo web works as a quick preview. Design for iOS and Android.

## Screen scaffolding (`src/components`)

- `TabHeader({ title, right })`: large title for tab roots.
- `ScreenHeader({ title, subtitle, middle, right, onBack })`: stack screens (back button, hairline).
- `useTabBarInset()` (`tab-bar.tsx`): bottom padding for scroll content on tab screens (the tab bar floats).
- `ApprovalCard` (`approval-card.tsx`): inline approval card used in chat and on the Approvals tab.

## Data (`src/lib`)

- `useWorkspace()` (`workspace.tsx`): `teammates`, `projects`, `members`, `threads`, `pendingApprovals`, `liveRuns`, `previews`, `refresh()`, `markRead(threadId)`, lookups `teammate(id)`, `project(id)`, `thread(id)`, `membersOf(projectId)`, `threadTeammates(threadId)`, `threadTitle(threadId)`, `isWorking(teammateId)`, `isThreadLive(threadId)`. Realtime covers threads, approvals, runs and new messages. Teammates, projects and members are not in the realtime publication: **call `refresh()` after you change them.**
- `api(path, { method, json })` (`api.ts`): agent-service with the user's JWT; throws `ApiError` with a human message and `status`.
- `supabase` (`supabase.ts`), row types (`types.ts`), `useSession()` (`session.ts`).

## Routes

| Route | File | Owner | Notes |
|---|---|---|---|
| `/sign-in` | `app/sign-in.tsx` | built | Only while signed out (`Stack.Protected`). |
| `/` (Chats tab) | `app/(tabs)/index.tsx` | built | Projects + DMs, unread dots, live state. |
| `/team` | `app/(tabs)/team.tsx` | **placeholder** | Roster → `/teammate/[id]`, "New teammate" → `/teammate/new`. |
| `/approvals` | `app/(tabs)/approvals.tsx` | built | Pending / History segment. Tab shows a badge. |
| `/activity` | `app/(tabs)/activity.tsx` | **placeholder** | Activity feed. |
| `/settings` | `app/(tabs)/settings.tsx` | **placeholder** | Theme (`setPreference`), Connections link, push registration (`push_tokens`), sign out. |
| `/chat/[threadId]` | `app/chat/[threadId].tsx` | built | `dm:<id>` or `proj:<id>`. Push taps and `tubelight://chat/<threadId>` land here. Tab bar hidden. |
| `/teammate/new` | `app/teammate/new.tsx` | **placeholder** | Presented as a `formSheet` (root layout). Chat list empty state links here. |
| `/teammate/[id]` | `app/teammate/[id].tsx` | **placeholder** | Profile/editor. DM header links here. |
| `/project/new` | `app/project/new.tsx` | **placeholder** | `formSheet`. Chat list header links here. |
| `/project/[id]/settings` | `app/project/[id]/settings.tsx` | **placeholder** | Members, event rules. Project thread header links here. |
| `/connections` | `app/connections.tsx` | **placeholder** | Composio OAuth; `tubelight://connections` returns here. |
| `/ui-gallery` | `app/ui-gallery.tsx` | built (dev) | Every primitive, both themes. |

Placeholders use `PlaceholderScreen` from `src/components/screen-header.tsx`; replace the file's contents.
New root-stack routes must be added inside the signed-in `Stack.Protected` in `app/_layout.tsx`.
