# Agent notes

## Setup

```sh
nvm use                 # Node from .nvmrc
npm install -g npm@11.18.0
npm ci
```

## Fast gate (same checks as CI)

```sh
npm run lint            # ESLint, all .ts/.tsx/.js/.mjs except dist/
npm run format:check    # Prettier
npm run typecheck       # tsc for src and for tests
npm test                # Vitest unit tests (CI runs them in two time zones)
TZ=Europe/Moscow npm test
TZ=America/Los_Angeles npm test
npm run build           # dist/: plugin.js, index.html, manifest.json, licenses + bundle checks
npm run pack            # sp-telos.zip from dist/ + package checks
npm run check:sh        # shellcheck and size limit for server/*.sh
```

## Git hooks

Husky runs Prettier and ESLint on staged files before a commit, and both type checks plus
`vitest run --changed main` before a push. Skip only the pre-push tests with
`git config sptelos.skipPrePushTests true`. Skip all hooks for one command with:

```sh
git -c core.hooksPath=/dev/null commit ...
git -c core.hooksPath=/dev/null push ...
```

## Notes

Plugin API types: npm 20.0.0 until the fork release package is available.
