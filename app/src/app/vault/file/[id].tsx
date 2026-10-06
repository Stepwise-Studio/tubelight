import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { MoreHorizontalIcon, Share08Icon, StarIcon } from '@hugeicons/core-free-icons'

import { itemMenu, shareItem, toggleStar } from '@/components/vault/actions'
import { ViewerScreen } from '@/components/vault/viewer-screen'
import { byFolderThenNewest, kindOf, useVault, viewable, type Viewable } from '@/lib/vault'
import { useTheme } from '@/theme'
import { IconButton } from '@/ui'

/** One file, full screen: photos and video on black under a floating header; documents on the canvas. */
export default function VaultFile() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useTheme()
  const { items } = useVault()
  const opened = items?.find((r) => r.id === id)
  const [currentId, setCurrentId] = useState(id) // the photo swiped to
  const item = items?.find((r) => r.id === currentId) ?? opened
  useEffect(() => { if (items && !items.some((r) => r.id === currentId)) router.back() }, [items, currentId]) // deleted

  const siblings = useMemo(() => (opened && items ? items.filter((r) => r.parent === opened.parent && r.kind === 'file' && kindOf(r.name, r.mime) === 'image').sort(byFolderThenNewest) : []), [items, opened])
  if (!item) return <View style={{ flex: 1, backgroundColor: c.canvas }} />
  return (
    <ViewerScreen item={viewable(opened ?? item)} shown={viewable(item)} siblings={siblings.map(viewable)} onIndex={(r: Viewable) => setCurrentId(r.id)}
      actions={(ink) => (
        <>
          <IconButton icon={StarIcon} color={item.starred ? c.warning : ink} accessibilityLabel={item.starred ? 'Unstar' : 'Star'} onPress={() => toggleStar(item)} />
          <IconButton icon={Share08Icon} color={ink} accessibilityLabel="Share" onPress={() => shareItem(viewable(item))} />
          <IconButton icon={MoreHorizontalIcon} color={ink} accessibilityLabel="More" onPress={() => itemMenu(item)} />
        </>
      )} />
  )
}
