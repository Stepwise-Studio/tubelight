// Tubelight as the phone's digital assistant (Android): the services the system binds, the see-through activity the
// panel draws in, its theme and the voice-interaction metadata. Kotlin sources live in ./assistant (copied into the
// app package at prebuild). JS side: index.ts registers the "assistant" component (src/assistant/root.tsx).
const fs = require('fs')
const path = require('path')
const { AndroidConfig, withAndroidManifest, withAndroidStyles, withDangerousMod } = require('expo/config-plugins')

const PKG = 'studio.stepwise.tubelight'
const BIND = 'android.permission.BIND_VOICE_INTERACTION'

function withFiles(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const main = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main')
    const java = path.join(main, 'java', ...PKG.split('.'))
    for (const f of fs.readdirSync(path.join(__dirname, 'assistant'))) {
      fs.copyFileSync(path.join(__dirname, 'assistant', f), path.join(java, f))
    }
    const xml = path.join(main, 'res/xml')
    fs.mkdirSync(xml, { recursive: true })
    fs.writeFileSync(path.join(xml, 'tubelight_assist.xml'), `<?xml version="1.0" encoding="utf-8"?>
<voice-interaction-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:sessionService="${PKG}.AssistSessionService"
    android:recognitionService="${PKG}.AssistRecognitionService"
    android:supportsAssist="true"
    android:supportsLaunchVoiceAssistFromKeyguard="true"
    android:supportsLocalInteraction="false" />
`)
    fs.writeFileSync(path.join(xml, 'tubelight_recognition.xml'), `<?xml version="1.0" encoding="utf-8"?>
<recognition-service xmlns:android="http://schemas.android.com/apk/res/android" />
`)
    return cfg
  }])
}

function withManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults)
    const named = (list, name) => (list ?? []).some((x) => x.$['android:name'] === name)
    app.service = app.service ?? []
    if (!named(app.service, '.AssistService')) {
      app.service.push(
        { $: { 'android:name': '.AssistService', 'android:exported': 'true', 'android:label': 'Tubelight', 'android:permission': BIND },
          'meta-data': [{ $: { 'android:name': 'android.voice_interaction', 'android:resource': '@xml/tubelight_assist' } }],
          'intent-filter': [{ action: [{ $: { 'android:name': 'android.service.voice.VoiceInteractionService' } }] }] },
        { $: { 'android:name': '.AssistSessionService', 'android:exported': 'true', 'android:permission': BIND } },
        { $: { 'android:name': '.AssistRecognitionService', 'android:exported': 'true', 'android:label': 'Tubelight' },
          'meta-data': [{ $: { 'android:name': 'android.speech', 'android:resource': '@xml/tubelight_recognition' } }],
          'intent-filter': [{ action: [{ $: { 'android:name': 'android.speech.RecognitionService' } }],
            category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }] }] },
      )
    }
    if (!named(app.activity, '.AssistActivity')) {
      app.activity.push({
        $: {
          'android:name': '.AssistActivity', 'android:exported': 'true', 'android:theme': '@style/Theme.Tubelight.Assist',
          'android:excludeFromRecents': 'true', 'android:launchMode': 'singleTask', 'android:taskAffinity': `${PKG}.assist`,
          'android:showWhenLocked': 'true', 'android:turnScreenOn': 'true', 'android:windowSoftInputMode': 'adjustResize',
          'android:configChanges': 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode',
        },
        'intent-filter': [{ action: [{ $: { 'android:name': 'android.intent.action.ASSIST' } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }] }],
      })
    }
    return cfg
  })
}

function withTheme(config) {
  return withAndroidStyles(config, (cfg) => {
    const styles = cfg.modResults.resources.style ?? []
    if (!styles.some((s) => s.$.name === 'Theme.Tubelight.Assist')) {
      const item = (name, value) => ({ $: { name }, _: value })
      styles.push({
        $: { name: 'Theme.Tubelight.Assist', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
        item: [
          item('android:windowIsTranslucent', 'true'),
          item('android:windowBackground', '@android:color/transparent'),
          item('android:windowNoTitle', 'true'),
          item('android:backgroundDimEnabled', 'false'),
          item('android:windowAnimationStyle', '@android:style/Animation.Translucent'),
          item('android:statusBarColor', '@android:color/transparent'),
          item('android:navigationBarColor', '@android:color/transparent'),
        ],
      })
      cfg.modResults.resources.style = styles
    }
    return cfg
  })
}

module.exports = (config) => withTheme(withManifest(withFiles(config)))
