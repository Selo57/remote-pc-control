# Contributing

Thanks for helping improve Remote PC Control.

## Local Setup

1. Install Node.js 24+, .NET SDK 8+, FFmpeg, and `cloudflared`.
2. Run `Configure-RemotePC.cmd` or copy `.env.example` to `.env`.
3. Run:

```powershell
npm install
npm run typecheck
npm test
npm run verify
```

## Pull Requests

- Keep changes focused.
- Do not commit secrets, logs, runtime databases, or built dependency folders.
- Add or update docs when behavior changes.
- Add regression tests for security-sensitive behavior.
- Run `npm run verify` before opening a PR.

## Code Style

- Prefer small, direct modules.
- Keep comments short and only where behavior is not obvious.
- Preserve Windows safety paths around input, capture, and local-only controls.
- Keep the public and administration listeners separate.

## Security Changes

For auth, input, tunnel, or session behavior, explain the security impact in the PR.
