# Autonomous Execution Guidelines

## Core Directives
- **Zero Full-Repo Audits:** Do not run broad audits, linters, or security checks on untouched code.
- **Local Verification Only:** When adding or editing a feature, run `npm run build` or the single relevant test file once. If it compiles, consider the step complete.
- **No Headless Browsers:** Do not invoke browser automation or attempt to connect to browser runtimes. UI testing is strictly manual by the user.
- **Incremental Progression:** Complete one concrete feature, ensure the build passes, and move directly to the next feature without refactoring previous working code.

## Technology Boundaries
- Do not modify files in `supabase/migrations/` unless explicitly directed.
- Keep all state changes strictly local within React state or existing hooks.
