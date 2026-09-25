import { Tabs } from 'expo-router'

import { TabBar } from '@/components/tab-bar'
import { useTheme } from '@/theme'

export default function TabsLayout() {
  const { c } = useTheme()
  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.canvas } }}>
      <Tabs.Screen name="index" options={{ title: 'Chats' }} />
      <Tabs.Screen name="team" options={{ title: 'Team' }} />
      <Tabs.Screen name="approvals" options={{ title: 'Approvals' }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  )
}
