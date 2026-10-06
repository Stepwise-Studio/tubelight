import { useState } from 'react'
import { View } from 'react-native'
import { Add01Icon, PieChart02Icon } from '@hugeicons/core-free-icons'

import { TabHeader } from '@/components/screen-header'
import { useTabBarInset } from '@/components/tab-bar'
import { StorageSheet, VaultBrowser, addMenu } from '@/components/vault/browser'
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
            <IconButton icon={Add01Icon} variant="soft" round accessibilityLabel="Add to your vault" onPress={() => addMenu('')} />
          </View>
        } />
      } />
      <StorageSheet open={storage} onClose={() => setStorage(false)} />
    </View>
  )
}
