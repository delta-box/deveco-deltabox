# DevEco Code host patch

English | [简体中文](README.zh-CN.md)

The baseline is recorded in [upstream.json](upstream.json): DevEco Code `0.2.4`, source commit `abc2d62370d46e7102828eb9e1f1783f0dd7474f`. The complete integration requires both [deveco-code.patch](deveco-code.patch) and this plugin.

The patch includes:

- `session.turn.stopping`: waits for plugin approval while the root conversation is still busy. Cancellation reaches the permission wait so that no unanswered request remains after cancellation.
- Direct results from `command.execute.before`: user-command results enter the session history without triggering another model inference.
- `shellEnv()` for plugin tools: reuses the host's CLI environment injection.
- Consistent override order in the tool registry: the named `read` entry point used for attachments also uses the plugin implementation, and model names no longer hide plugin-provided file tools.
- A dedicated “Review changes” panel in the Web UI and TUI: review mode, per-file addition/deletion summaries, and “Accept / Roll back” actions, while preserving the host's auto-accept policy.
- Write diffs in the TUI and shared Web UI, plus native card mappings for `shell` and `spec_write`.

Auto-accept behavior is preserved. DevEco CLI itself needs no changes: the AI launches it through the Deltabox shell, and generated files and command changes within the project belong to the same review scope.

## Build

```sh
npm ci
npm run build
npm run setup:host
```

Run these commands from this repository's root. Git, Node.js 22+, and Bun 1.4.2+ are required. By default, setup clones the pinned source into `host/.build/source`, builds a distribution for the current machine with the Web UI embedded, and installs it into `.local/deveco-code`. The build may download official dependencies, the CLI, and UI inspection tools. It leaves the system npm installation intact.

You can reuse a separate source checkout at the pinned revision:

```sh
node host/setup.mjs --source /absolute/path/to/deveco-code --bun /absolute/path/to/bun
node host/setup.mjs --source /absolute/path/to/deveco-code --check
```

The script verifies the commit and runs `git apply --check`. If the patch is already applied, it checks the reverse patch instead. A revision mismatch or patch conflict produces an error without resetting the source checkout. Build provenance and the patch SHA-256 are saved in `.local/deveco-code/deltabox-build.json`.

Launch from the target project directory:

```sh
node /absolute/path/to/deveco-deltabox/bin/deveco-deltabox.mjs
# Use the host's auto-accept mode.
node /absolute/path/to/deveco-deltabox/bin/deveco-deltabox.mjs run --auto "Your task"
```

The launcher appends the plugin through process-local `DEVECO_CONFIG_CONTENT` and disables automatic updates for this custom host. Any existing configuration in that environment variable must be a JSON object. Set `DEVECO_DELTABOX_BIN` to use another patched binary. The official `deveco` installation and your global configuration are left intact.

## Regression tests

From the host's `packages/opencode` directory, run:

```sh
bun typecheck
bun test --isolate --timeout 30000 test/tool/registry.test.ts test/plugin/trigger.test.ts test/session/prompt.test.ts
```

Run `bun typecheck` separately in `packages/app`, `packages/tui`, and `packages/ui`. See the [plugin README](../README.md) for plugin commands and tests against the real backend.

Full HTTP conversation tests use isolated temporary directories and a local mock model, without a model account. Enable the upstream internal test-build option with the commands below. The result goes into the separate `.local/deveco-code-test` directory; the production launcher does not select it by default.

```sh
node host/setup.mjs --source /absolute/path/to/deveco-code --test-build
DEVECO_BIN="$PWD/.local/deveco-code-test/bin/deveco" npm run test:host-e2e
```

Normal builds retain the product agreement flow; real use follows DevEco's own confirmation process. Compilation, device installation, and signing still require local SDKs, devices, and accounts.
