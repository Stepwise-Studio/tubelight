import { Tabs } from 'expo-router'
import { Easing, useWindowDimensions } from 'react-native'

import { EdgeScreen } from '@/components/bottom-edge'
import { TabBar, useTabBarInset } from '@/components/tab-bar'
import { useTheme } from '@/theme'

export default function TabsLayout() {
  const { c } = useTheme()
  const inset = useTabBarInset()
  const { width } = useWindowDimensions()
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      // Content fades under the floating capsule, which is frosted glass.
      screenLayout={({ children }) => <EdgeScreen height={inset}>{children}</EdgeScreen>}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: c.canvas },
        // Direction-aware slide: progress is -1 for tabs left of the current one, 1 for those right of it, so the
        // new page comes in from the side its tab is on and the old one leaves the other way (native driver).
        animation: 'shift',
        transitionSpec: { animation: 'timing', config: { duration: 320, easing: Easing.bezier(0.22, 1, 0.36, 1) } },
        sceneStyleInterpolator: ({ current }) => ({
          sceneStyle: { transform: [{ translateX: current.progress.interpolate({ inputRange: [-1, 0, 1], outputRange: [-width, 0, width] }) }] },
        }),
        // Tabs you aren't on stop re-rendering on every workspace change.
        freezeOnBlur: true,
      }}>
      <Tabs.Screen name="index" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="vault" options={{ title: 'Vault' }} />
      <Tabs.Screen name="tasks" options={{ title: 'Orbit' }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  )
}
