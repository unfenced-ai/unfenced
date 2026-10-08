# Contributing

This repository contains the Unfenced MCP connector, SDK, examples, and client tests.
Please open an issue for substantial API changes before implementing them.

Use Node.js 22.19+ to develop this repository and the pnpm version declared in `package.json`:

```sh
corepack enable
pnpm install
pnpm format
pnpm verify
```

Keep TypeScript strict and use `.js` extensions in relative imports. Test changes to
the actual requests, responses, or tool behavior. Build before transport tests because
those tests start the packaged entry points. Do not add dependencies on the private engine.

Use placeholder credentials and synthetic fixture data. Report security issues through
the private channel in [SECURITY.md](./SECURITY.md).

Contributions are licensed under this repository's MIT license.
