import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Flat config for ESLint 10. Keep generated bundles and dependencies out of
// the scan while applying the TypeScript parser to the source tree.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '*.tsbuildinfo', 'public/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'server/**/*.js', '*.js', '*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // The app intentionally uses a few dynamic card payloads from Scryfall;
      // keep lint focused on runtime correctness rather than banning those.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // TypeScript supplies the React namespace used in a few public prop
      // types; the base no-undef rule cannot understand that type space.
      'no-undef': 'off',
    },
  },
)
