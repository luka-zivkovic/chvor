# Contributing to Chvor

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

**Prerequisites:** Node.js 20+, pnpm 10+

```bash
git clone https://github.com/your-username/chvor.git
cd chvor
pnpm install
```

### Running locally

```bash
# Start both client and server
pnpm dev

# Or run them separately
pnpm dev:client   # Vite dev server on :5173
pnpm dev:server   # Hono server on :3001
```

### Project structure

```
chvor/
  apps/
    client/     # React + Vite frontend
    server/     # Hono + Node.js backend
  packages/
    shared/     # Shared TypeScript types
  data/
    bundled-skills/   # Default skills
    bundled-tools/    # Default tool definitions
```

### Code quality

```bash
pnpm typecheck    # TypeScript checking
pnpm lint         # ESLint
pnpm format       # Prettier
```

## How to Contribute

### Bug reports

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Node version, browser)

### Feature requests

Open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

### Pull requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure `pnpm typecheck` and `pnpm lint` pass
4. Write a clear PR description
5. Submit!

### Good first contributions

- New MCP tool integrations (add a `.tool.md` file to `data/bundled-tools/`)
- Documentation improvements
- Bug fixes
- UI polish

## Code Style

- TypeScript throughout
- Prettier for formatting (runs on save with most editors)
- ESLint 9 flat config
- Functional React components with hooks
- Zustand for client state management
- Hono for server routes

## License

By contributing, you agree that your contributions will be licensed under the [Chvor Sustainable Use License v1.0](LICENSE.md).
