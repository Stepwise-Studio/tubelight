// The Profile banner: one of your pictures (assets/banners, ~1080×720 JPEGs), drifting very slowly. As a photo the
// drift is a native transform (smooth, no JS); dithered it's a Skia shader stepping ~12 times a second, which suits
// pixels. Both stop while `live` is off (tab out of view, app in the background).
import { Canvas, Fill, ImageShader, Shader, Skia, useImage } from '@shopify/react-native-skia'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import { useEffect, useState } from 'react'
import { AppState, View, type ViewStyle } from 'react-native'
import Animated, {
  Easing, cancelAnimation, useAnimatedStyle, useDerivedValue, useFrameCallback, useSharedValue, withRepeat, withTiming,
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
const STEP_MS = 83

// Ordered (Bayer 8×8) dither in 3 dp blocks, six levels per channel: the picture's own colours, as print pixels.
// It samples through the same slow zoom-and-drift as the photo, so the pixels shimmer as it moves.
const DITHER = Skia.RuntimeEffect.Make(`
uniform shader image;
uniform float2 size;
uniform float t;
uniform float cell;
float bayer2(float2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(float2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(float2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
half4 main(float2 xy) {
  float2 b = floor(xy / cell);
  float2 c = size * 0.5;
  float2 q = c + ((b + 0.5) * cell - c) / ${ZOOM} + float2(sin(t * 0.26) * 8.0, cos(t * 0.21) * 3.0);
  half4 col = image.eval(q);
  float th = bayer8(b) - 0.5;
  float3 o = floor(col.rgb * 5.0 + 0.5 + th) / 5.0;
  return half4(clamp(o, 0.0, 1.0), 1.0);
}`)

/** Whether a slow animation should run: `live` and the app in front. */
function useRunning(live: boolean) {
  const [active, setActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'))
    return () => sub.remove()
  }, [])
  return live && active
}

export function Banner({ id, dither, live, style }: { id?: string; dither?: boolean; live: boolean; style?: ViewStyle }) {
  const src = bannerOf(id).src
  return (
    <View style={[{ overflow: 'hidden', backgroundColor: '#09090b' }, style]}>
      {dither && DITHER ? <Dithered src={src} live={live} /> : <Photo src={src} live={live} />}
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

function Dithered({ src, live }: { src: number; live: boolean }) {
  const run = useRunning(live)
  const image = useImage(src)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const t = useSharedValue(0)
  const last = useSharedValue(0)
  const tick = useFrameCallback((f) => {
    if (f.timeSinceFirstFrame - last.get() < STEP_MS) return
    last.set(f.timeSinceFirstFrame)
    t.set(t.get() + STEP_MS / 1000)
  }, false)
  useEffect(() => { tick.setActive(run); return () => tick.setActive(false) }, [run, tick])
  const uniforms = useDerivedValue(() => ({ size: [size.w, size.h], t: t.get(), cell: 3 }))
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {image && size.w > 0 && (
        <Canvas style={{ flex: 1 }}>
          <Fill>
            <Shader source={DITHER!} uniforms={uniforms}>
              <ImageShader image={image} fit="cover" rect={{ x: 0, y: 0, width: size.w, height: size.h }} />
            </Shader>
          </Fill>
        </Canvas>
      )}
    </View>
  )
}
