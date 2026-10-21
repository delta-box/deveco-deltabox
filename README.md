# DevEco Code + Deltabox

English | [简体中文](README.zh-CN.md)

Run DevEco Code's AI file operations and commands in a shared Deltabox filesystem view, with diff inspection, acceptance, and rollback.

This integration targets [DevEco Code](https://gitcode.com/openharmony-sig/deveco-code) (`deveco`), the AI coding terminal. [DevEco CLI](https://gitcode.com/openharmony-sig/deveco-cli) (`devecocli`) is the HarmonyOS toolchain, which the AI can invoke through this plugin's `shell` tool.

## Installation

The integration requires both the plugin and its companion DevEco Code host patch. No npm package has been published yet. The official `0.2.4` release lacks the complete end-of-turn approval hooks; the plugin refuses to run project tools when the host lacks the required capabilities. Clone and build this repository:

```sh
git clone https://github.com/delta-box/deveco-deltabox.git
cd deveco-deltabox
npm ci
npm run build
npm run setup:host
```

The build requires Git, Node.js 22+, Bun 1.4.2+, and network access. The setup script pins the upstream commit, applies the patch, and builds a host with the Web UI included. See [Host build and patch](host/README.md). Then run the launcher from your target project directory:

```sh
node /absolute/path/to/deveco-deltabox/bin/deveco-deltabox.mjs
```

The launcher loads the plugin automatically and reuses your model, account, and permission settings. It leaves the system installations of `deveco` and `devecocli` intact. If you launch a patched host yourself, you can instead add the plugin's **absolute path** to your project's `deveco.jsonc`, placing it last in the plugin list:

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/deveco-deltabox/dist/plugin.js"
  ]
}
```

Run `/sandbox-status` to check the backend and actual filesystem mode. The plugin dependencies install the Deltabox native module and executable for your platform. The default `native` transport needs no separate service.

`glob` and `grep` require `rg` on PATH. The sandbox shell invokes the host's `shell.env` hook, preserving toolchain PATH entries, authentication sources, and other injected environment variables, and passes them to Deltabox as structured arguments. The host generally prefers its bundled CLI; you can also invoke an installed `devecocli` by its absolute path in the shell. Configure SDK, Java, and other paths according to the [official DevEco CLI instructions](https://gitcode.com/openharmony-sig/deveco-cli).

macOS is currently the platform supported by both the official DevEco distribution and Deltabox. The adapter also accepts compatible hosts on Linux; initialization is explicitly rejected on Windows. The plugin uses DevEco's `@opencode-ai/plugin` interface, pinned to `1.17.9`.

## Capabilities aligned with Pi / DeepSeek Harness

| Capability | DevEco integration |
| --- | --- |
| File reads and writes | Overrides `read`, `write`, `edit`, and `spec_write`; the native transport uses Buffer I/O |
| File consistency | Checks the content version of observed files; existing files must be read before being overwritten and read again after external or shell changes |
| Commands | Overrides the current `shell` and legacy `bash` tools, executing through Deltabox |
| Search | `glob`, `grep`, `find`, and `list` / `ls` use the same sandbox view |
| Multi-file patches | `apply_patch` supports adding, modifying, deleting, and moving files; all patches are validated before writing |
| Persistent sessions | Consecutive tool calls reuse a session; child agents share their parent conversation's queue and review scope |
| Session handoff | Clean passthrough sessions can be reused; private mode releases clean idle sessions and takes a fresh snapshot; pending or skipped changes retain their original owner |
| Review | `task`, `tool`, and `risky` modes preserve the rollback point from before the first change |
| End of task | The host waits for the root conversation's approval to finish before becoming idle; child agents do not commit the shared scope early |
| Permission policy | Normal mode waits for a decision; host auto-accept mode commits as usual; rejection rolls back; cancellation preserves the pending scope |
| Native UI | Web / TUI file diffs and shell output cards; a dedicated “Review changes” panel with file summaries, review mode, and “Accept / Roll back” buttons |
| User commands | Return results directly, without another model call to summarize them or approval information appended to model tool output |
| Backends | `native`, persistent stdio `serve`, and per-call `cli` |
| Filesystem | `auto`, `cbcow-through`, `cbcow-private`, and `copy-private`; strict durability options are supported |
| Status | Reports the actual mode, fallback reason, visibility, durability level, and taint status |

The default `task` mode blocks for review at the end of a complete task in the root conversation, after all model reasoning, tool calls, and foreground subtasks in that user turn have finished. It does not prompt after each model message or file write. An empty review scope closes automatically when there are no changes. The AI's `sandbox_review` tool only inspects diffs and cannot trigger early approval. The host's auto-accept mode remains available.

`tool` and `risky` check for changes after each tool call that could modify the project and request review only when changes exist. Shell commands always count as potentially modifying tools. Reads, searches, and commands that make no changes do not prompt. “Accept” or host auto-approval commits the current scope; “Roll back” restores the previous state. Cancellation and approval UI failures leave the scope pending, and errors propagate to the host. Partial changes left by a failed modifying operation remain available for review.

The three modes follow Pi / DSH task and tool boundaries. One interaction differs: DSH waits for approval at the end of a task by default, while Pi only notifies the user about pending review and relies on user commands to commit or roll back. DevEco follows DSH's blocking approval behavior. Like Pi, `tool` / `risky` check for changes after modifying tools run.

As with the DSH integration, the UI shows per-tool diffs and approval summaries. Use `/sandbox-review` or `/sandbox-diff` for cumulative diffs. DevEco's Git review sidebar still shows the host repository state; uncommitted sandbox files in private mode do not appear there.

If the same project still has an unresolved native session, a new conversation may receive a backend error indicating that the project is in use. Return to the original conversation to commit or roll back before starting new work.

## User commands

| Command | Behavior |
| --- | --- |
| `/sandbox-status` | Show session, review mode, and filesystem status |
| `/sandbox-review` | Show the current pending diff |
| `/sandbox-commit` | Accept all changes in the current review scope |
| `/sandbox-abort` | Restore the state from before the current review scope |
| `/sandbox-skip` | Keep pending changes and their original rollback point |
| `/sandbox-diff [from] [to]` | Compare checkpoints |
| `/sandbox-mode task\|tool\|risky` | Switch modes while preserving any pending review scope |

The host's user-command hook executes these commands and returns their results directly, without calling the model. The AI only receives the `sandbox_review` diff inspection tool; it has no model tools for directly committing or rolling back changes.

The end-of-task review panel uses “Accept / Roll back”. After cancelling, use the commands above to handle pending changes. Changes in `cbcow-through` are immediately visible to the host; choose a private mode if you need file contents isolated until commit.

## Configuration

The plugin first reads `$XDG_CONFIG_HOME/deveco/deltabox.json` (default: `~/.config/deveco/deltabox.json`), then merges `deltabox.json` from the project root. The `filesystem` and `review` objects are each merged across the two configuration layers. Invalid configuration blocks tool execution.

Defaults:

```json
{
  "transport": "native",
  "bin": "deltabox",
  "nativeAddon": null,
  "policy": null,
  "stateDir": null,
  "runtimeDir": null,
  "trusted": false,
  "timeoutMs": 660000,
  "filesystem": {
    "mode": "auto",
    "require": false,
    "durability": "fast",
    "groupCommitMs": null
  },
  "review": { "mode": "task" }
}
```

- `native` uses in-process Node-API sessions and byte I/O. By default, it loads the backend from npm dependencies. Use `bin` and `nativeAddon` to specify a local executable and matching `.node` module. Both the legacy constructor arguments used by Deltabox source builds and the options object in published version `0.1.2` are supported.
- `serve` and `cli` use the executable specified by `bin` (default: `deltabox` on PATH). After a communication timeout, the connection is no longer reused, avoiding incorrect assumptions about an ambiguous modification result.
- `trusted: false` enables command isolation by default. Only the `native` transport supports explicitly setting it to `true` for the trusted execution mode used by other adapters, in which commands run with host permissions. `serve` / `cli` always use backend isolation.
- `policy` points to a Deltabox policy file. Configure additional SDK and build-cache directories and environment variables there as required by your toolchain. File rollback covers changes within the project.
- Relative paths for `stateDir`, `runtimeDir`, `policy`, and `nativeAddon` resolve from the project root. State paths normalize macOS aliases such as `/var` and `/tmp`.
- `filesystem.require: true` prevents filesystem mode fallback. Platform restrictions for strict durability and group commit follow Deltabox itself.

## Compatibility and limitations

Unadapted tools fail explicitly, including MCP tools and HarmonyOS inspection, device, and screenshot tools that directly invoke host processes. Use the sandbox `shell` to run the corresponding `devecocli` commands. `switch_cwd`, `plan_write`, and `batch` are also disabled. `spec_write` is treated as an ordinary reviewable file write and does not run the host's built-in document validation.

The plugin disables the host's LSP, automatic formatter, and snapshot features to keep them from writing to the project outside the adapted tools. Run compilation, validation, and formatting commands in the shell instead. Another plugin that overrides the same tools can change the execution path, so load this plugin last and avoid duplicate overrides. The integration relies on a trusted DevEco host and plugin configuration.

Commands use the backend's fixed 600-second deadline and run in the foreground. PTYs, interactive input, and background task control are unavailable; background child agents are also explicitly rejected. UI cancellation does not interrupt a command already running in the native backend. The queue waits for it to finish before handling subsequent operations, and existing changes remain pending review. File reads support only UTF-8 text and directory listings. Content-version checks prevent overwriting changes to observed files. The host has no equivalent of DSH's opaque FsTarget API, so the plugin does not expose file handles that can be reused across sessions.

External effects such as device installation, signing services, and network requests are outside project file rollback. On normal plugin shutdown or deletion of the owning session, unaccepted changes are rolled back before resources are released. Recovery after an abnormal exit uses Deltabox's own session recovery capabilities.

## Validation

```sh
npm test

# Use a local Deltabox build; the .node module must match the executable.
DELTABOX_BIN=/absolute/path/to/deltabox \
DELTABOX_NATIVE_ADDON=/absolute/path/to/deltabox.node \
  npm run test:integration

# Use the patched host's debug tool entry point; no model account is required.
DEVECO_BIN=/absolute/path/to/deveco \
  npm run test:host

# Run full conversations with an isolated test build and a local HTTP model fixture.
DEVECO_BIN=/absolute/path/to/test-build/deveco \
DEVECO_CLI_BIN=/absolute/path/to/devecocli \
  npm run test:host-e2e
```

Integration tests use isolated temporary projects to exercise three transports across three filesystem modes: file reads and writes, shell commands, patches, commits, rollback after skipping review, shutdown cleanup, rejection of symlinks escaping the project, and private snapshot refresh. Integration tests explicitly skip when `DELTABOX_BIN` is unset. Unit tests cover host hooks, approval events, session handoff, concurrency, cancellation, transport failures, and patch validation.

Full host tests cover blocking approval, acceptance, rejection, cancellation, `run --auto`, native diff metadata, shell environment forwarding, and user commands that do not call the model. They use the upstream internal test-build option; production builds retain the normal product agreement flow. Browser tests use an isolated local model and an agreement-query fixture scoped to the test page, without calling the agreement acceptance endpoint. See the [validation record](host/VERIFICATION.md).

The interface was checked against [DevEco Code source](https://gitcode.com/openharmony-sig/deveco-code) at commit `abc2d62370d46e7102828eb9e1f1783f0dd7474f`. Actual device builds, debugging, and installation still depend on local SDK, device, and account configuration.

## License

The plugin is licensed under [Apache-2.0](LICENSE). Upstream code included in the DevEco Code host patch retains its [MIT license](host/UPSTREAM-LICENSE).
