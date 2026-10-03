# The same system in React Native (Expo)

The Tubelight app (`/home/akhil/tubelight/app`, `src/ui/` + `src/theme/`) is the reference implementation: when in
doubt, read how a primitive is built there and copy its approach. Everything in SKILL.md applies; this is what
changes natively.

## Dependencies

Install native packages with `npx expo install <pkg>` (resolves SDK-compatible versions); a new native package
means a new dev-client build. Expo changes every SDK: check `https://docs.expo.dev/llms.txt` before using an API.

| Need | Package | Notes |
|---|---|---|
| Squircles | `react-native-fast-squircle` (`cornerSmoothing={0.6}`) | Supports borders, shadows, `overflow: 'hidden'`. In Skia, draw the same shape with `@lisse/core` `generatePath(w, h, { radius, smoothing: 0.6 })`. Give it a `.web.tsx` fallback (plain `borderRadius`) |
| Motion | `react-native-reanimated` 4 (+ `react-native-worklets`), `react-native-gesture-handler` | Tokens as TS (below); `withTiming(v, { duration, easing: Easing.bezier(...) })` |
| Graphics | `@shopify/react-native-skia` | Gradients, beams, glows, charts |
| Icons | `@hugeicons/react-native` + `@hugeicons/core-free-icons` | Same sizes/strokes as web |
| Font | Inter Display TTFs embedded with the `expo-font` config plugin; families `InterDisplay-Regular/-Medium/-SemiBold/-Bold` | Use the family per weight (fontWeight alone won't pick the face on Android) |
| Keyboard | `react-native-keyboard-controller` | Composer above the keyboard; interactive dismiss |
| Blur | `expo-blur` | Floating chrome, bottom-edge blur |
| Images | `expo-image` | Aspect ratio from `onLoad` when unknown; `contentFit` |
| Haptics | `expo-haptics` | tap / light / success / warning / error, meaningful moments only |
| Avatars | DiceBear Notionists SVG/PNG, cached per seed + colour | Static; no avatar animation |
| Delight | libraries.dev RN ports (border beam, thinking orbs, voice glow) vendored under `src/vendor/` with their LICENSE | Same rationing rule as web |

## Tokens in TypeScript

Mirror `assets/tokens.css` in `src/theme/tokens.ts` (`light`/`dark` palettes with the same names: `canvas`, `panel`,
`panel2`, `panel3`, `line`, `edge`, `ink`…`ink4`, `tube`, `tubeSoft`, semantic + `Soft`, `wash`, `scrim`,
`solidFrom/To`…), `type` (the scale, each with its font family), `space`, `radius { sm 8, md 12, lg 16, xl 20,
sheet 28 }`, `SMOOTHING = 0.6`, `HIT = 44`. Motion in `src/theme/motion.ts`:

```ts
export const duration = { stagger: 40, micro: 80, quick: 150, fast: 250, medium: 350, slow: 400, verySlow: 500 }
export const ease = {
  smoothOut: Easing.bezier(0.22, 1, 0.36, 1), inOut: Easing.inOut(Easing.ease), out: Easing.out(Easing.ease),
  bounce: Easing.bezier(0.34, 1.36, 0.64, 1), close: Easing.bezier(0.4, 0, 0.2, 1), icon: Easing.bezier(0.2, 0, 0, 1),
}
export const spring = { duration: 300, dampingRatio: 1 } // no bounce
export const staggerDelay = (i: number) => Math.min(i * duration.stagger, 300)
```

Elevation via `boxShadow` strings on the outer wrapper (outside the squircle clip), e.g. light level 1
`0 1px 2px -1px rgba(0,0,0,0.06), 0 2px 8px -2px rgba(0,0,0,0.05)`.

## Primitives worth having (as in Tubelight `src/ui/`)

`Text` (variant, color key, `tabular`, font scaling capped at 1.3), `Icon`, `Squircle`, `Press` (squircle + 0.96
scale + wash + optional haptic), `Surface`, `Button` (solid/soft/outline/ghost/destructive; sm 34 / md 44 / lg 50),
`IconButton` (label required), `TextField` (tube focus ring, error shake), `Chip`, `Segment`, `Toggle`, `Checkbox`,
`ListRow`, `Divider`, `Sheet` (floating squircle 28, drag/scrim/back to close, rides the keyboard), `showMenu`
(action sheet), `Dialog`, `confirm()`, `toast()`, `Skeleton` + `Reveal`, `EmptyState`, `Badge`, `ChoiceRow` /
`PickerField` (radio rows in a sheet). Port the design from Stepwise UI (`https://ui.stepwise.studio/r/<name>.json`
for the source, `https://ui.stepwise.studio/docs/<name>` to see it rendered) — sizes, colours, variants exactly, not
approximated from code alone.

## Native-only rules

- 44pt minimum touch targets; safe areas everywhere; Android predictive back closes sheets/overlays first.
- Haptics on send, approve/reject, long-press, toggles that matter, success — not on every tap.
- Inverted lists for chat; `maintainVisibleContentPosition` so older messages don't jump.
- A horizontal `ScrollView` (tables, code) inside a shrink-to-fit container inflates it on Android: give the
  container a definite width.
- Reanimated in release builds: a view whose resting state is only reached by animating a shared value can snap
  back to its first-render style on a later commit. Make the initial render the resting state (entering/exiting
  layout animations, offsets that rest at 0) and verify animations on a release build, not just the dev client.
- Full-height sheets that must sit above the navigator render in a root host, not as transparent modal routes
  (Android's native stack can draw tabs over them).
