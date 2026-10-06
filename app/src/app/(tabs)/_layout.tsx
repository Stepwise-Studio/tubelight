import { Tabs } from 'expo-router'

import { EdgeScreen } from '@/components/bottom-edge'
import { TabBar, useTabBarInset } from '@/components/tab-bar'
import { useTheme } from '@/theme'

export default function TabsLayout() {
  const { c } = useTheme()
  const inset = useTabBarInset()
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      // Content fades and blurs under the floating capsule (the capsule itself stays sharp above it).
      screenLayout={({ children }) => <EdgeScreen height={inset}>{children}</EdgeScreen>}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.canvas } }}>
      <Tabs.Screen name="index" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks' }} />
      <Tabs.Screen name="vault" options={{ title: 'Vault' }} />
      <Tabs.Screen name="approvals" options={{ title: 'Approvals' }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  )
}
