# DevEco Code 宿主补丁

[English](README.md) | 简体中文

基线见 [upstream.json](upstream.json)：DevEco Code `0.2.4` 对应源码提交 `abc2d62370d46e7102828eb9e1f1783f0dd7474f`。完整接入需要 [deveco-code.patch](deveco-code.patch) 和 `host/adapter/` 中的适配器源码。

补丁包含：

- `session.turn.stopping`：根对话仍处于 busy 时等待插件审批；取消信号传递到权限等待，取消后不遗留待答请求。
- `command.execute.before` 的直接结果：用户命令进入会话记录，不触发新的模型推理。
- 插件工具的 `shellEnv()`：复用宿主 CLI 环境注入。
- 工具注册表统一覆盖顺序，附件的命名 `read` 入口也使用插件版本；模型名称不再隐藏插件提供的文件工具。
- Web / TUI 专用“审核修改”面板：审核模式、逐文件增删摘要，以及“接受 / 回滚”操作。
- TUI 和共享 Web UI 的写入差异，以及 `shell`、`spec_write` 原生卡片映射。

Deltabox 修改需通过 `/sandbox-commit` 接受或 `/sandbox-abort` 回滚；宿主使用 `--auto` 时也是如此。DevEco CLI 本体不需要修改：AI 通过 Deltabox shell 启动 CLI，项目内的生成文件和命令修改由同一审阅范围管理。

## 内置挂载适配器

构建前，setup 将 `host/adapter/` 复制到固定版本的宿主源码。适配器直接导入原生 LSP 和 Formatter 模块，无需新增插件 API。补丁包含按配置启用的内置注册、查询函数复用和运行时打包。启动器启用 `deltabox: true`，不再加载旧外部入口；两者不能同时注册。LSP 和格式化仍需显式启用，并使用 Lite 挂载视图。Git 快照仍然关闭。

`deltabox-build.json` 同时记录适配器源码和宿主补丁的哈希。目标适配器文件已存在且内容不同时，构建会报错，不覆盖本地修改。当前内置集成见[使用指导](../docs/deltabox.zh-CN.md)，旧外部入口见[旧插件说明](../docs/legacy-plugin.zh-CN.md)。

## 构建

```sh
npm ci
npm run build
npm run setup:host
```

以上命令从本仓库根目录运行。需要 Git、Node.js 22+、Bun 1.4.2+。默认在 `host/.build/source` 克隆固定版本，再构建带嵌入式 Web UI 的本机发行包，安装到 `.local/deveco-code`。构建可能下载官方依赖、CLI 和 UI 检查工具。不会修改系统 npm 安装。

已有固定版本的独立源码目录可以复用：

```sh
node host/setup.mjs --source /absolute/path/to/deveco-code --bun /absolute/path/to/bun
node host/setup.mjs --source /absolute/path/to/deveco-code --check
```

脚本核对提交号，执行 `git apply --check`；若已应用则检查反向补丁。版本不符或补丁冲突直接报错，不重置源码。构建来源和补丁 SHA-256 保存在 `.local/deveco-code/deltabox-build.json`。

在目标项目目录启动：

```sh
node /absolute/path/to/deveco-deltabox/bin/deveco-deltabox.mjs
# 自动接受宿主权限请求；沙箱修改仍需手动提交
node /absolute/path/to/deveco-deltabox/bin/deveco-deltabox.mjs run --auto "你的任务"
```

启动器通过进程级 `DEVECO_CONFIG_CONTENT` 启用内置适配器、关闭该定制宿主的自动升级。已有环境配置需为 JSON 对象。也可设置 `DEVECO_DELTABOX_BIN` 使用其他已应用补丁的二进制。官方 `deveco` 和用户全局配置保留原状。

## 回归测试

从宿主 `packages/opencode` 运行：

```sh
bun typecheck
bun test --isolate --timeout 30000 test/tool/registry.test.ts test/plugin/trigger.test.ts test/session/prompt.test.ts
```

从 `packages/app`、`packages/tui`、`packages/ui` 分别运行 `bun typecheck`。插件的命令和真实后端测试见[插件说明](../README.zh-CN.md)。

无模型账户的完整 HTTP 对话测试使用独立临时目录和本地模拟模型。上游内部测试构建选项通过以下命令启用，输出到单独的 `.local/deveco-code-test`，正式启动器不会默认使用它：

```sh
node host/setup.mjs --source /absolute/path/to/deveco-code --test-build
DEVECO_BIN="$PWD/.local/deveco-code-test/bin/deveco" npm run test:bundled-host
```

`test:host` 和 `test:host-e2e` 脚本验证旧外部入口。Windows 临时目录清理可能卡住；可设置 `DEVECO_E2E_KEEP=1` 保留现场检查。

正常构建不跳过产品协议；真实使用时沿用 DevEco 自身的确认流程。编译、设备安装、签名仍需要本地 SDK、设备和账户。
