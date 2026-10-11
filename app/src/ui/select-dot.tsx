// The mark on something you can choose while selecting several: one filled circle with a tick when chosen, a thin
// ring when not. `onImage` for marks over photos and folders (a white ring on a soft shade).
import { View } from 'react-native'
import { Tick02Icon } from '@hugeicons/core-free-icons'

import { useTheme } from '@/theme'

import { Icon } from './icon'

export function SelectDot({ on, size = 24, onImage }: { on: boolean; size?: number; onImage?: boolean }) {
  const { c } = useTheme()
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center',
      backgroundColor: on ? c.tube : onImage ? 'rgba(0,0,0,0.25)' : 'transparent',
      borderWidth: on ? 0 : 1.5, borderColor: onImage ? '#fff' : c.ink4 }}>
      {on && <Icon icon={Tick02Icon} size={size * 0.6} color="#fff" strokeWidth={2.6} />}
    </View>
  )
}
