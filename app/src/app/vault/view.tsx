// A file that isn't in the vault, in the vault's viewer: one from Google Drive or one on the phone. Whoever opens it
// hands over the file and what its ⋯ menu offers (openOutside).
import { View } from 'react-native'

import { opened } from '@/components/vault/outside'
import { ViewerScreen } from '@/components/vault/viewer-screen'
import { useTheme } from '@/theme'

export default function OutsideFile() {
  const { c } = useTheme()
  if (!opened) return <View style={{ flex: 1, backgroundColor: c.canvas }} />
  const { item, menu } = opened
  return (
    <ViewerScreen item={item} menu={menu} />
  )
}
