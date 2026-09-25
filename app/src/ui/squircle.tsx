import SquircleView from 'react-native-fast-squircle'
import Animated from 'react-native-reanimated'

// Every rounded surface. The library's default cornerSmoothing is 0.6, the exact
// smoothing Stepwise UI uses on the web (SMOOTHING in the theme).

/** A View whose corners are squircles. */
export const Squircle = SquircleView

/** Reanimated-driven squircle, for animated styles. */
export const AnimatedSquircle = Animated.createAnimatedComponent(SquircleView)
