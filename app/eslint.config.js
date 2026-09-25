// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // src/vendor holds third-party libraries.dev ports, kept as upstream wrote them.
    ignores: ["dist/*", "src/vendor/**"],
  }
]);
