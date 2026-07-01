# Changelog

## Unreleased

- Separated public traffic from token-authenticated local administration.
- Added persistent per-client and global PIN throttling.
- Added 8 to 12 digit PIN enforcement and local device approval.
- Added WebSocket origin checks, message-size limits, and runtime schemas.
- Added security-boundary tests, ESLint, formatting checks, and Windows CI.
- Pinned dependencies and removed development tools from production dependencies.
- Made Coturn require an explicit password and pinned its container image.
- Removed native binaries and debug symbols from source release ZIPs.
- Added secret-safe setup guidance for public GitHub releases.
- Added a Windows configuration wizard for local `.env` setup.
- Switched public defaults away from a hardcoded control PIN.
- Added project security, contribution, and release documentation.
- Added `gdigrab` capture as the stable default with optional `ddagrab`.
