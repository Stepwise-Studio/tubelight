// Entry: the app (expo-router), plus the assistant panel's own root, drawn by AssistActivity (plugins/with-assistant.js).
import 'expo-router/entry'
import { AppRegistry } from 'react-native'

import { AssistantRoot } from './src/assistant/root'

AppRegistry.registerComponent('assistant', () => AssistantRoot)
