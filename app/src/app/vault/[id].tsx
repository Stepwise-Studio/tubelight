import { router, useLocalSearchParams } from 'expo-router'
import { useEffect } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Add01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { itemMenu } from '@/components/vault/actions'
import { VaultBrowser, addMenu } from '@/components/vault/browser'
import { CATEGORIES, pathTo, useVault, type Category } from '@/lib/vault'
import { useTheme } from '@/theme'
import { IconButton } from '@/ui'

/** A folder in the Vault: the same browser, scoped to it, with the way back up in the header. */
export default function VaultFolder() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const { items } = useVault()
  const category = id.startsWith('cat:') ? (id.slice(4) as Category) : undefined
  const folder = items?.find((r) => r.id === id)
  const trail = folder && items ? pathTo(folder.parent, items).map((p) => p.name) : []
  useEffect(() => { if (items && !folder && !category) router.back() }, [items, folder, category]) // deleted elsewhere
  if (category) {
    return (
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <ScreenHeader title={CATEGORIES.find((x) => x.id === category)?.label ?? 'Files'} subtitle="Vault" />
        <VaultBrowser category={category} header={<View style={{ height: 12 }} />} bottom={insets.bottom + 12} />
      </View>
    )
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title={folder?.name ?? 'Folder'} subtitle={['Vault', ...trail].join(' / ')} right={folder && (
        <>
          <IconButton icon={Add01Icon} accessibilityLabel={`Add to ${folder.name}`} onPress={() => addMenu(folder.id)} />
          <IconButton icon={MoreHorizontalIcon} accessibilityLabel={`More for ${folder.name}`} onPress={() => itemMenu(folder)} />
        </>
      )} />
      <VaultBrowser parent={id} header={<View style={{ height: 12 }} />} bottom={insets.bottom + 12} />
    </View>
  )
}
