# Publishing Checklist

## Repository

- [ ] Initialize Git and verify ignored files with `git status --ignored`.
- [ ] Confirm `.env`, `data/`, `logs/`, `dist/`, `release/`, `node_modules/`,
      native `bin/`, and native `obj/` are not tracked.
- [ ] Enable GitHub private vulnerability reporting.
- [ ] Confirm the repository owner and support expectations are clear.

## Security

- [ ] Run `npm run verify`.
- [ ] Review `npm audit --omit=dev` and the accepted Werift risk in `SECURITY.md`.
- [ ] Test that the public port returns 404 for `/host` and `/api/host/*`.
- [ ] Test the administration API with missing, invalid, and valid tokens.
- [ ] Test pending-device approval and device revocation.
- [ ] Confirm the Cloudflare tunnel targets only the public port.
- [ ] Confirm Coturn refuses to start without `TURN_PASSWORD`.

## Secrets and Local State

- [ ] Confirm `.env`, databases, logs, generated keys, webhooks, and tunnel
      credentials are absent from staged files.
- [ ] Search staged files and release archives for Discord webhook URLs,
      `trycloudflare.com` URLs, private keys, and generated secrets.
- [ ] Rotate any secret that was ever committed or shared.

## Release

- [ ] Run `Create-ReleaseZip.cmd`.
- [ ] Confirm the archive contains no `.exe`, `.dll`, `.pdb`, native `bin/`, or
      native `obj/` files.
- [ ] Test the ZIP on a clean Windows machine.
- [ ] Test `Configure-RemotePC.cmd`, `Start-RemotePC.cmd`, and
      `Stop-RemotePC.cmd`.
- [ ] Confirm the README setup flow matches the release.
