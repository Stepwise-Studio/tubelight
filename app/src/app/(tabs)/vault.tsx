import { View } from 'react-native'
import { Add01Icon } from '@hugeicons/core-free-icons'

import { TabHeader } from '@/components/screen-header'
import { useTabBarInset } from '@/components/tab-bar'
import { VaultBrowser, addMenu } from '@/components/vault/browser'
import { IconButton } from '@/ui'

export default function Vault() {
  const inset = useTabBarInset()
  return (
    <View style={{ flex: 1 }}>
      <VaultBrowser root parent="" bottom={inset} header={
        <TabHeader title="Vault" right={<IconButton icon={Add01Icon} variant="soft" round accessibilityLabel="Add to your vault" onPress={() => addMenu('')} />} />
      } />
    </View>
  )
}
