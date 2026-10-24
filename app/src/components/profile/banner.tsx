// The Profile banner: one of your pictures (assets/banners, ~1080×720 JPEGs), drifting very slowly: a native
// transform (smooth, no JS), stopped while `live` is off (tab out of view, app in the background).
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import { useEffect, useState } from 'react'
import { AppState, View, type ViewStyle } from 'react-native'
import Animated, {
  Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated'

export const BANNERS = [
  { id: 'meadow', name: 'Meadow', src: require('../../../assets/banners/meadow.jpg') },
  { id: 'street', name: 'Street', src: require('../../../assets/banners/street.jpg') },
  { id: 'bloom', name: 'Bloom', src: require('../../../assets/banners/bloom.jpg') },
  { id: 'light', name: 'Light', src: require('../../../assets/banners/light.jpg') },
  { id: 'grass', name: 'Grass', src: require('../../../assets/banners/grass.jpg') },
] as const
export type BannerId = (typeof BANNERS)[number]['id']
export const bannerOf = (id?: string) => BANNERS.find((b) => b.id === id) ?? BANNERS[0]

const DRIFT_MS = 24_000
const ZOOM = 1.08
/** Whether a slow animation should run: `live` and the app in front. */
function useRunning(live: boolean) {
  const [active, setActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'))
    return () => sub.remove()
  }, [])
  return live && active
}

export function Banner({ id, live, style }: { id?: string; live: boolean; style?: ViewStyle }) {
  const src = bannerOf(id).src
  return (
    <View style={[{ overflow: 'hidden', backgroundColor: '#09090b' }, style]}>
      <Photo src={src} live={live} />
      {/* A soft shade under the status bar, so its icons read over a bright sky. */}
      <LinearGradient colors={['rgba(0,0,0,0.38)', 'rgba(0,0,0,0)']} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 120 }} pointerEvents="none" />
    </View>
  )
}

function Photo({ src, live }: { src: number; live: boolean }) {
  const run = useRunning(live)
  const p = useSharedValue(0)
  useEffect(() => {
    if (run) p.set(withRepeat(withTiming(1, { duration: DRIFT_MS, easing: Easing.inOut(Easing.sin) }), -1, true))
    else cancelAnimation(p)
  }, [run, p])
  const drift = useAnimatedStyle(() => ({ transform: [{ scale: ZOOM }, { translateX: (p.get() - 0.5) * 16 }] }))
  return (
    <Animated.View style={[{ flex: 1 }, drift]}>
      <Image source={src} style={{ flex: 1 }} contentFit="cover" transition={200} />
    </Animated.View>
  )
}
