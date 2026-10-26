// No scroll bars anywhere in the app (the user's call): every Android scroll view draws its thumb from the theme, so a
// transparent thumb in the app's themes hides them all, ours and the libraries', without a prop on each list.
const { withAndroidStyles } = require('expo/config-plugins')

const THEMES = ['AppTheme', 'Theme.Tubelight.Assist']
const ITEMS = { 'android:scrollbarThumbVertical': '@android:color/transparent', 'android:scrollbarThumbHorizontal': '@android:color/transparent' }

module.exports = (config) => withAndroidStyles(config, (cfg) => {
  for (const style of cfg.modResults.resources.style ?? []) {
    if (!THEMES.includes(style.$.name)) continue
    style.item = (style.item ?? []).filter((i) => !(i.$.name in ITEMS))
    for (const [name, value] of Object.entries(ITEMS)) style.item.push({ $: { name }, _: value })
  }
  return cfg
})
