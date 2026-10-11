// The floating +: a circle above the nav (or the screen's bottom) on the right, as WhatsApp's, whose menu grows out of
// it in place. The Vault, Google Drive and the phone's folders each pass what can be added there.
import { useRef } from 'react'
import { View } from 'react-native'
import { Add01Icon } from '@hugeicons/core-free-icons'

import { useTheme } from '@/theme'
import { Icon, Press, elevation, haptic, showContextMenu, type MenuItem } from '@/ui'

const SIZE = 56

function Face() {
  const { c } = useTheme()
  return (
    <View style={{ width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: c.solidTo, borderWidth: 1, borderColor: c.solidEdge }}>
      <Icon icon={Add01Icon} size={24} color={c.solidInk} strokeWidth={2} />
    </View>
  )
}

export function Fab({ items, bottom, label }: { items: () => MenuItem[]; bottom: number; label: string }) {
  const { scheme } = useTheme()
  const ref = useRef<View>(null)
  return (
    <View ref={ref} collapsable={false} style={[{ position: 'absolute', right: 16, bottom, borderRadius: SIZE / 2 }, elevation(scheme)]}>
      <Press radius={SIZE / 2} smoothing={0} onPress={() => { haptic.tap(); showContextMenu(ref.current, <Face />, items()) }} accessibilityLabel={label}>
        <Face />
      </Press>
    </View>
  )
}
