# Security Policy

Remote PC Control can expose a real Windows desktop. Treat every deployment as
sensitive.

## Supported Versions

Security fixes target the current `main` branch until versioned release support
is announced.

## Reporting a Vulnerability

Do not open a public issue for authentication bypasses, session theft, input
control, secret disclosure, or tunnel exposure.

Before the repository is published, its owner must enable GitHub private
vulnerability reporting under **Settings → Security → Code security**. After it
is enabled, use **Security → Report a vulnerability** in the repository.

Include:

- Impact and affected component
- Reproduction steps
- Affected commit or release
- Suggested mitigation, if known
- Sanitized logs with PINs, tokens, webhooks, tunnel URLs, and private IPs removed

## Security Boundaries

- Port 8787 is the public application and signaling listener.
- Port 8788 is the default loopback-only administration listener.
- Administration requires the generated token in `data/admin.key`.
- A loopback source address is never sufficient authorization.
- New devices require local approval by default.
- Public mutating APIs require a signed session and CSRF token.
- WebSocket sessions require authentication, an allowed origin, bounded payloads,
  and validated message schemas.

## Secret Handling

Never commit or attach:

- `.env` or local environment variants
- `data/` or `logs/`
- SQLite databases, WAL files, or generated key files
- Discord webhooks
- Cloudflare credentials or generated tunnel URLs
- TURN passwords

If a secret reaches Git history or a published archive, remove it from the
artifact and rotate it. Deleting the visible file alone is not sufficient.

## Known Transitive Dependency Risk

Werift 0.23.0 declares `ip` 2.0.1, which is affected by
[GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp).
No patched `ip` release is available. The application does not use `ip`
directly. The installed Werift code uses address conversion, format, and
loopback helpers rather than the advisory's affected `isPublic` classification,
and ICE signaling is unavailable before authentication. This remains an
accepted transitive risk rather than a resolved finding.

Recheck the Werift dependency tree before every release and upgrade or replace
Werift when a maintained path removes the affected package.

## Deployment Requirements

- Use an 8 to 12 digit random PIN.
- Keep local device approval enabled.
- Prefer a named Cloudflare Tunnel protected by Cloudflare Access.
- Never route the administration port through a tunnel or reverse proxy.
- Supply a strong explicit Coturn password.
- Run `npm run verify` before release.
- Code-sign executable releases before distributing them broadly.
