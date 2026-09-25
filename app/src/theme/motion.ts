// transitions.dev motion tokens, for Reanimated. Match on usage, not the nearest number.
// Rules (transitions-polish): closes are faster than opens, never delay a close,
// stagger 40ms capped near 300ms total, press scale 0.96, bounce only for badge pop.
import { Easing, type WithSpringConfig, type WithTimingConfig } from 'react-native-reanimated'

export const duration = {
  stagger: 40, // per-item stagger offset
  micro: 80, // intent delay, shake segment
  quick: 150, // modal/dropdown close, text swap, press
  fast: 250, // icon swap, dropdown/modal open, tabs sliding, page slide, accordion
  medium: 350, // panel close, toast close
  slow: 400, // panel open, skeleton content reveal
  verySlow: 500, // badge appear, success check, emphasis
} as const

export const ease = {
  smoothOut: Easing.bezier(0.22, 1, 0.36, 1), // default for surfaces
  inOut: Easing.inOut(Easing.ease), // icon/text swap, skeleton reveal
  out: Easing.out(Easing.ease), // tooltip
  linear: Easing.linear, // shimmer, pulse
  bounce: Easing.bezier(0.34, 1.36, 0.64, 1), // badge pop only
  bounceStrong: Easing.bezier(0.34, 3.85, 0.64, 1), // avatar return
  close: Easing.bezier(0.4, 0, 0.2, 1), // badge close
  icon: Easing.bezier(0.2, 0, 0, 1), // contextual icon cross-fade
} as const

export const distance = { micro: 4, small: 6, base: 8, medium: 12, large: 30 } as const

export const scale = { large: 0.96, medium: 0.97, small: 0.98, tiny: 0.99, press: 0.96 } as const

export const blur = { small: 2, medium: 3, large: 8 } as const

/** Shorthand for `withTiming` configs. */
export const timing = (d: number, easing = ease.smoothOut): WithTimingConfig => ({ duration: d, easing })

/** Critically damped spring (bounce 0), for drags that release into place. */
export const spring: WithSpringConfig = { duration: 300, dampingRatio: 1 }

/** Cap a stagger so the whole sequence stays under ~300ms. */
export const staggerDelay = (i: number, step: number = duration.stagger) => Math.min(i * step, 300)
