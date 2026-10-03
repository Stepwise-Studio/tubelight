// Full-screen view of a chat image, with Save to photos. Images are signed Supabase URLs; saving downloads to the
// cache, then adds it to the gallery (Pictures) with expo-media-library.
import { File, Paths } from 'expo-file-system'
import { Image } from 'expo-image'
import { Asset, requestPermissionsAsync } from 'expo-media-library'
import { useState } from 'react'
import { Modal, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Cancel01Icon, Download03Icon } from '@hugeicons/core-free-icons'

import { Button, IconButton, haptic, toast } from '@/ui'

export async function saveImage(url: string, name: string) {
  try {
    const { granted } = await requestPermissionsAsync(true, ['photo'])
    if (!granted) { toast({ title: 'Allow Tubelight to save photos', body: 'Turn it on in Settings, then try again.', tone: 'error' }); return }
    const file = new File(Paths.cache, `${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`)
    await File.downloadFileAsync(url, file)
    await Asset.create(file.uri)
    file.delete()
    haptic.success()
    toast({ title: 'Saved to your photos', tone: 'success' })
  } catch (e) {
    toast({ title: 'Unable to save the image', body: (e as Error).message, tone: 'error' })
  }
}

export function ImageViewer({ url, name, onClose }: { url: string | null; name: string; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const [saving, setSaving] = useState(false)
  return (
    <Modal visible={!!url} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      {/* A Modal is its own window on Android: gestures need their own root here. */}
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
        {url && <Zoomable url={url} name={name} />}
        <View style={{ position: 'absolute', top: insets.top + 8, right: 12 }}>
          <IconButton icon={Cancel01Icon} variant="soft" round accessibilityLabel="Close" onPress={onClose} />
        </View>
        <View style={{ position: 'absolute', left: 20, right: 20, bottom: insets.bottom + 20 }}>
          <Button label="Save to photos" icon={Download03Icon} loading={saving} fullWidth
            onPress={async () => { if (!url) return; setSaving(true); await saveImage(url, name); setSaving(false) }} />
        </View>
      </GestureHandlerRootView>
    </Modal>
  )
}

/** Pinch to zoom (up to 5×), drag while zoomed, double-tap to zoom in where you tapped or back out. */
function Zoomable({ url, name }: { url: string; name: string }) {
  const { width, height } = useWindowDimensions()
  const scale = useSharedValue(1)
  const base = useSharedValue(1)
  const x = useSharedValue(0)
  const y = useSharedValue(0)
  const startX = useSharedValue(0)
  const startY = useSharedValue(0)
  const clamp = (v: number, s: number, size: number) => {
    'worklet'
    const max = (size * (s - 1)) / 2
    return Math.min(Math.max(v, -max), max)
  }
  const settle = (s: number, nx: number, ny: number) => {
    'worklet'
    scale.value = withTiming(s)
    base.value = s
    x.value = withTiming(nx)
    y.value = withTiming(ny)
    startX.value = nx
    startY.value = ny
  }
  const pinch = Gesture.Pinch()
    .onUpdate((e) => { scale.value = Math.min(Math.max(base.value * e.scale, 1), 5) })
    .onEnd(() => {
      base.value = scale.value
      if (scale.value <= 1.01) settle(1, 0, 0)
      else settle(scale.value, clamp(x.value, scale.value, width), clamp(y.value, scale.value, height))
    })
  const pan = Gesture.Pan().averageTouches(true)
    .onUpdate((e) => {
      x.value = clamp(startX.value + e.translationX, scale.value, width)
      y.value = clamp(startY.value + e.translationY, scale.value, height)
    })
    .onEnd(() => { startX.value = x.value; startY.value = y.value })
  const doubleTap = Gesture.Tap().numberOfTaps(2)
    .onEnd((e) => {
      if (base.value > 1) { settle(1, 0, 0); return }
      const s = 2.5
      settle(s, clamp((width / 2 - e.x) * (s - 1), s, width), clamp((height / 2 - e.y) * (s - 1), s, height))
    })
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }))
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
      <Animated.View style={[{ flex: 1 }, style]}>
        <Image source={url} style={{ flex: 1 }} contentFit="contain" accessibilityLabel={name} accessibilityHint="Pinch or double-tap to zoom" />
      </Animated.View>
    </GestureDetector>
  )
}
