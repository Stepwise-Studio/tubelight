import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BackHandler, Pressable, TextInput, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Cancel01Icon, Search01Icon } from '@hugeicons/core-free-icons'

import { motion, type as typeScale, useTheme } from '@/theme'
import { Icon, IconButton, Text, haptic } from '@/ui'

/**
 * Title (or `children`) left, a search button right that morphs into the full search bar: the capsule grows leftward over
 * the logo (250 ms open / 150 ms close, smooth-out), the field fades in and takes focus. Back or ✕ closes
 * and clears it.
 */
export function HeaderSearch({ value, onChange, placeholder, children }: { value: string; onChange: (v: string) => void; placeholder: string; children?: ReactNode }) {
  const { c, scheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(0)
  const p = useSharedValue(0)
  const input = useRef<TextInput>(null)

  useEffect(() => {
    p.value = withTiming(open ? 1 : 0, { duration: open ? motion.duration.fast : motion.duration.quick, easing: motion.ease.smoothOut })
    if (!open) return
    const focus = setTimeout(() => input.current?.focus(), motion.duration.fast / 2)
    const back = BackHandler.addEventListener('hardwareBackPress', () => { setOpen(false); onChange(''); return true })
    return () => { clearTimeout(focus); back.remove() }
  }, [open, p, onChange])

  const capsule = useAnimatedStyle(() => ({ width: width ? 40 + (width - 40) * p.value : 40 }))
  const field = useAnimatedStyle(() => ({ opacity: p.value }))
  const logo = useAnimatedStyle(() => ({ opacity: 1 - p.value, transform: [{ translateX: -12 * p.value }] }))

  const close = () => { haptic.tap(); setOpen(false); onChange(''); input.current?.blur() }

  return (
    <View style={{ height: 44, justifyContent: 'center' }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View style={logo} pointerEvents={open ? 'none' : 'auto'}>{children ?? <Text variant="heading">Tubelight</Text>}</Animated.View>
      <Animated.View style={[{ position: 'absolute', right: 0, height: 40, borderRadius: 20, overflow: 'hidden', backgroundColor: c.panel2, flexDirection: 'row', alignItems: 'center' }, capsule]}>
        <Pressable
          onPress={() => { if (!open) { haptic.tap(); setOpen(true) } }}
          disabled={open}
          accessibilityRole="button"
          accessibilityLabel="Search"
          accessibilityState={{ expanded: open }}
          style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon icon={Search01Icon} size={18} color={open ? 'ink3' : 'ink2'} />
        </Pressable>
        <Animated.View style={[{ flex: 1, flexDirection: 'row', alignItems: 'center' }, field]} pointerEvents={open ? 'auto' : 'none'}>
          <TextInput
            ref={input}
            value={value}
            onChangeText={onChange}
            placeholder={placeholder}
            placeholderTextColor={c.ink4}
            selectionColor={c.tube}
            cursorColor={c.tube}
            keyboardAppearance={scheme}
            returnKeyType="search"
            accessibilityLabel={placeholder}
            style={[typeScale.body, { flex: 1, color: c.ink, paddingVertical: 0 }]}
          />
          <IconButton icon={Cancel01Icon} round size={32} iconSize={16} color={c.ink3} accessibilityLabel="Close search" onPress={close} style={{ marginRight: 4 }} />
        </Animated.View>
      </Animated.View>
    </View>
  )
}

