import { useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import { PieChart02Icon, StarIcon } from '@hugeicons/core-free-icons'

import { TabHeader } from '@/components/screen-header'
import { useTabBarInset } from '@/components/tab-bar'
import { StorageSheet, VaultBrowser } from '@/components/vault/browser'
import { IconButton } from '@/ui'

export default function Vault() {
  const inset = useTabBarInset()
  const [storage, setStorage] = useState(false)
  return (
    <View style={{ flex: 1 }}>
      <VaultBrowser root parent="" bottom={inset} header={
        <TabHeader title="Vault" right={
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <IconButton icon={PieChart02Icon} variant="soft" round accessibilityLabel="Storage" onPress={() => setStorage(true)} />
            <IconButton icon={StarIcon} variant="soft" round accessibilityLabel="Starred files" onPress={() => router.push({ pathname: '/vault/[id]', params: { id: 'cat:starred' } })} />
          </View>
        } />
      } />
      <StorageSheet open={storage} onClose={() => setStorage(false)} />
    </View>
  )
}
