# Windows local trials

Windows requires a compatible Deltabox backend, WinFsp, and Microsoft MXC PSEC
with filesystem deny support. Install Node.js 22.20+ (the file search helper
uses `path.matchesGlob`), PowerShell 7, Git, ripgrep, and Bun 1.4.2+.
Ensure `node.exe`, `pwsh.exe`, and `rg.exe` are on PATH. `DELTABOX_NODE` and
`DELTABOX_POWERSHELL` can select explicit executable paths.

The lockfile currently selects Deltabox 0.1.2, which does not support Windows.
The Windows tests used locally supplied Deltabox 0.1.3 wrapper and win32-x64
packages. Until compatible packages are published, install those matching
artifacts explicitly instead of running `npm ci`:

```powershell
npm install --no-save --package-lock=false C:/artifacts/deltabox-lite-0.1.3.tgz C:/artifacts/deltabox-lite-win32-x64-0.1.3.tgz
npm run build
npm run setup:host
```

The setup script builds the patched Windows host and embedded Web UI into
`.local/deveco-code`. It does not replace the system `deveco` installation.
From a target project, run:

```powershell
node C:/path/to/deveco-deltabox/bin/deveco-deltabox.mjs
```

The existing `deveco-deltabox` npm command points to this same launcher.
The launcher also accepts `web --hostname 127.0.0.1 --port 4097`.
Normal builds retain the upstream agreement and account login flow.

Use `cbcow-private` with `require: true` for changes that stay private until
acceptance. State and runtime directories must be outside the target project
and separate from one another. Configure these in the usual user/project
`deltabox.json`, or provide a machine configuration in `.local/deltabox.json`
inside this integration checkout. The launcher selects that file through
`DEVECO_DELTABOX_CONFIG`; an explicit environment override takes precedence.
Project configuration remains the final layer.

Commands use PowerShell 7 on Windows. Use relative project paths in shell
source. Internal file tools pass paths as separate arguments for mapping into
the sandbox view. Add required SDK/toolchain read directories to the backend
policy. HarmonyOS SDK, signing, and device installation were not validated.

## Validation

Run `npm test`, then `node --test tests/windows.integration.mjs` after building.
The Windows integration tests generate their own temporary policy and projects.
They cover native, serve, and cli transports, special-character paths, file
operations, search, patches, shell environment forwarding, approval, rollback,
and cleanup.

For the host tests, set `DEVECO_BIN` to the appropriate patched executable.
`DELTABOX_TEST_POLICY` optionally supplies a toolchain policy. `npm run test:host`
uses the production host; `npm run test:host-e2e` uses an isolated host built
with `--test-build`, as described in `host/README.md`.

On 2026-10-21 the local Windows run passed 42 unit tests, all three Windows
transport scenarios, the production host smoke test, and the full HTTP
conversation test covering accept/reject/cancel, auto approval, foreground
child agents, and task/tool/risky boundaries.

Network approval is not wired into this adapter. The tested Windows backend
reported degraded network-policy protection, and tests used `allow_audit`.
File approval must not be interpreted as approval or isolation of network
requests. A newer backend and a separate adapter change are needed to connect
network denials to user approval and per-command grants.
