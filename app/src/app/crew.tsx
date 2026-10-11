import { useState } from 'react'
import { View } from 'react-native'

import { CrewList } from '@/components/crew'
import { HeaderSearch } from '@/components/header-search'
import { ScreenHeader } from '@/components/screen-header'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Text } from '@/ui'

/** Every teammate, reached from the Crew row hidden above the chats. */
export default function Crew() {
  const { c } = useTheme()
  const ws = useWorkspace()
  const [query, setQuery] = useState('')
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader
        middle={
          <View style={{ marginRight: 12 }}>
            <HeaderSearch value={query} onChange={setQuery} placeholder="Search your crew">
              <Text variant="headline" accessibilityRole="header">Crew</Text>
              <Text variant="footnote" color="ink3">{ws.teammates.length} teammates</Text>
            </HeaderSearch>
          </View>
        }
      />
      <View style={{ height: 12 }} />
      <CrewList query={query} />
    </View>
  )
}
