# DevEco Code + Deltabox

English | [简体中文](README.zh-CN.md)

Run DevEco Code's file operations and commands in a Deltabox filesystem view, with change inspection, acceptance and rollback. The companion host build includes the adapter and the pinned `deltabox-lite@0.1.4` runtime.

## Build and launch

The integration requires the companion DevEco Code host. Git, Node.js 22+, Bun 1.4.2+ and network access are required. Windows also requires [WinFsp](https://winfsp.dev).

```sh
git clone https://github.com/delta-box/deveco-deltabox.git
cd deveco-deltabox
npm ci
npm run setup:host
```

Run the launcher from your project directory:

```sh
node /absolute/path/to/deveco-deltabox/bin/deveco-deltabox.mjs
```

The launcher enables the built-in adapter through process-local `DEVECO_CONFIG_CONTENT` and preserves other settings. It leaves the system `deveco` and `devecocli` installations intact. If you run the newly built host directly, enable `"deltabox": true` in your project or user `deveco.jsonc`. Do not also register the legacy external plugin.

See the [usage guide](docs/deltabox.md) for screenshots, commands, review modes, filesystem modes and configuration, and [host build instructions](host/README.md) for build options.

## Mounted LSP and formatting

Enable `"lsp": true` and `"formatter": true` in DevEco configuration to use the existing native services in Lite's mounted view. Formatting and diagnostics are restored after writes, edits and patches. Formatted contents participate in review, acceptance and rollback. The runtime must expose a host-accessible mountpoint; there is no fallback to the original project.

The sources in `host/adapter/` import DevEco's internal services directly and are compiled into the companion host. No language-service capability is added to the plugin API, and the native LSP and Formatter directories remain unchanged. The host tool's query function is shared with the mounted adapter. Build provenance records both the host patch and adapter source hashes.

The package's existing `dist/plugin.js` external entry remains available for older patched hosts, with its previous feature set. It does not acquire the new mounted language services simply by being loaded externally. See [legacy external plugin instructions](docs/legacy-plugin.md). Use the companion build and launcher for the current integration.

## Verification

```sh
npm test
npm pack --dry-run
node host/setup.mjs --source /path/to/pinned/deveco-code --check
```

Run host regression tests from its `packages/opencode` directory:

```sh
bun typecheck
bun test --timeout 30000 test/plugin/deltabox.test.ts test/plugin/deltabox-language.test.ts
```

Set `DEVECO_TEST_DELTABOX_NATIVE=1` to include real Lite mounted-view formatting, diagnostics, commit and rollback tests on a machine with the native filesystem provider installed. See [validation records](host/VERIFICATION.md) for the scope of completed checks.
