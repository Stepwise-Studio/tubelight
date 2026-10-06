import { View } from 'react-native'
import { Add01Icon } from '@hugeicons/core-free-icons'

import { TabHeader } from '@/components/screen-header'
import { VaultBrowser, addMenu } from '@/components/vault/browser'
import { IconButton } from '@/ui'

export default function Vault() {
  return (
    <View style={{ flex: 1 }}>
      <VaultBrowser root parent="" header={
        <TabHeader title="Vault" right={<IconButton icon={Add01Icon} variant="soft" round accessibilityLabel="Add to your vault" onPress={() => addMenu('')} />} />
      } />
    </View>
  )
}
