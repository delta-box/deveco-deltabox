# DevEco Code integration validation record

English | [简体中文](VERIFICATION.zh-CN.md)

Validation date: 2026-10-21. Platform: macOS arm64.

## Build provenance

- Host source: [DevEco Code](https://gitcode.com/openharmony-sig/deveco-code), commit `abc2d62370d46e7102828eb9e1f1783f0dd7474f`, corresponding to DevEco Code `0.2.4` and plugin API `1.17.9`.
- Locally installed DevEco CLI: `1.3.9`. The global `deveco` and `devecocli` installations were left intact.
- Deltabox: validated separately with a release build from the Deltabox Lite project and npm `deltabox-lite@0.1.2`.
- Build tools: Node.js `24.9.0`, Bun `1.4.3`.
- The [host patch](deveco-code.patch) passed `git apply --check` against the original upstream files. After applying it, all 18 patched files matched the build source byte for byte. The patch digest is recorded in the local distribution's `deltabox-build.json`.

The production distribution is in `../.local/deveco-code`, and the internal test distribution is in `../.local/deveco-code-test`, relative to this document. The production build includes the Web UI and retains the product agreement flow. The test build uses the upstream internal test option. The launcher selects the production build by default.

## Results

| Scope | Result | Checks performed |
| --- | --- | --- |
| Plugin unit tests | 42 passed | Host capability checks, review lifecycle, all three review modes, read-only diff inspection without early approval, permission events, cancellation, queueing, transport failures, patch validation, and file content-version checks |
| Integration with a Deltabox source build | 12 passed, 1 skipped | Three transports across three filesystem modes; commit, rollback, and cleanup; rejection of symlinks escaping the project; private-session snapshot refresh; optional CLI test not enabled |
| Integration with npm Deltabox | 12 passed, 1 skipped | The same real-backend matrix; the CLI was launched, but the scaffolding test was skipped because the SDK was unavailable |
| Host tool registry and plugin regression tests | 16 passed | Tool deduplication, plugin-backed attachment reads, custom file tools across models, and plugin triggers |
| Existing host prompt regression tests | 62 passed, 1 upstream skip | Prompts, cancellation, permissions, attachments, commands, background messages, and related behavior; the upstream-disabled v2 projector case remained skipped |
| Full host HTTP conversations | 1 passed, with multiple scenarios | Real host, local model fixture, and real Deltabox; acceptance, rejection, cancellation, auto-accept, foreground child agents, and actual pause boundaries for task / tool / risky modes |
| Production launcher smoke test | 1 passed | Plugin loaded through the launcher; private file reads and writes, commands, commit, and rollback through the real debug tool entry point |
| Type checks | Passed | Plugin and host backend, Web app, TUI, and shared UI packages |
| Build and distribution checks | Passed | Production host build, test host build, and `npm pack --dry-run` |

The full host tests confirmed:

- In normal mode, the session stays busy until approval is resolved, and private files have not yet reached the host directory. Accepting writes them to the host; rejecting removes the pending changes.
- Cancelling approval leaves no unanswered permission request. Changes remain in the pending review scope and can be inspected or rolled back with user commands.
- `deveco run --auto` approves Deltabox review and commits changes without requiring additional manual confirmation.
- Foreground child agents share the parent task's sandbox. They do not commit early; the parent task requests approval for the shared scope.
- `task` reviews two files together after the final model response. `tool` / `risky` pause after each write; reads and commands that make no changes do not trigger extra review.
- File tool output retains native diff metadata. Approval descriptions are not appended to model tool output.
- User commands such as `/sandbox-status` produce session results directly without increasing the model request count.
- Environment variables injected by `shell.env`, including values containing `$()`, quotes, and similar characters, arrive unchanged. The locally installed DevEco CLI can run through the sandbox.

## Browser validation

A real host and Web development page were started in an isolated temporary project. A local HTTP model fixture produced write, edit, apply_patch, and shell calls, which were exercised in Chrome.

Observed UI elements included green added lines for new files, red/green diffs for edited files, patch cards, shell cards, and the dedicated review panel. The panel displayed the file count, review mode, and per-file addition/deletion summaries. The tested Chinese UI used “审核修改” (Review changes), “接受 / 回滚” (Accept / Roll back), and “等待审核” (Waiting for review). Accepting in the browser committed all three files. Rolling back the next turn removed that turn's file, preserved the previously accepted files, and returned the session to idle.

The screenshots below show the tested review UI before and after customization. Complete test logs remain local.

| Before | After |
| --- | --- |
| ![Generic permission prompt](https://raw.githubusercontent.com/delta-box/deveco-deltabox/main/docs/images/deltabox-review-before.png) | ![Deltabox review with Accept and Roll back actions](https://raw.githubusercontent.com/delta-box/deveco-deltabox/main/docs/images/deltabox-review-after.png) |

The browser fixture replaced only the test tab's read-only product agreement status query. It did not call the agreement acceptance endpoint or change the user's agreement state or global configuration. No external model account was used. The TUI passed type checking and compilation; interactive validation was performed in the Web UI.

The final production page with the custom review UI passed checks in Chrome at `1280×800` and `390×844`: the expected page was loaded and nonempty, there was no framework error overlay or console/runtime error, and both action buttons were fully visible and unobstructed. The Browser plugin was unavailable, so Playwright and the repository-required agent-browser were used. Across three independent browser contexts loading the production page, the median time until the review panel was ready changed from 626 ms to 538 ms. This small sample was used to look for obvious regressions and is not a performance improvement claim.

Browser tests waited for command-list initialization to complete before closing each context. Closing too early interrupts upstream cache initialization and can cause later `/command` requests to return 499. This error did not occur in the final isolated validation instance.

The installer updates binaries by copying to a temporary file and renaming it, avoiding SIGKILL on new processes caused by overwriting a running macOS executable in place. The installed binary's `--version` check and full host conversations both passed.

## Environment limitations

No usable DevEco Studio / Command Line Tools SDK was available locally. DevEco CLI was executed inside Deltabox, but creating a HarmonyOS project returned a missing-installation-directory error. Scaffolding, full compilation, signing, and installation on a physical device therefore remain unverified. After setting `DEVECO_CLI_STUDIO_PATH` or `DEVECO_CLI_CLT_PATH`, rerun the integration tests with `DEVECO_CLI_BIN` configured.

Use `/sandbox-review` and `/sandbox-diff` for cumulative sandbox diffs. DevEco's Git review sidebar continues to show the host repository view, so uncommitted files in private mode do not appear there early. See the [plugin README](../README.md) for command deadlines, foreground execution, and external side effects.
