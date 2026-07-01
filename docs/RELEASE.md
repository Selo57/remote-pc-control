# Release Process

## Recommended Public Release

Publish the source repository and, optionally, the source-oriented ZIP produced
by `Create-ReleaseZip.cmd`.

The ZIP may include compiled web and Node output for convenience. It must not
include native executables, DLLs, PDBs, local configuration, runtime state,
dependencies, or generated keys.

## Verification

```powershell
npm install
npm run verify
Create-ReleaseZip.cmd
```

The release script stages an explicit allowlist, removes native `bin/` and
`obj/`, rejects executable and debug-symbol files, and scans text files for
Discord webhook and Quick Tunnel URL patterns.

After generation, inspect the archive and test it on a clean Windows machine.

## Executable Releases

Do not publish unsigned executable builds as official releases. Before adding an
installer or binary package:

- Establish a stable publisher identity.
- Code-sign the installer and executables.
- Generate checksums and a software bill of materials.
- Build in CI from a tagged commit.
- Test installation, upgrades, uninstallation, and SmartScreen behavior.
- Publish the exact build procedure.
