# DevEco Code 宿主补丁

基线见 [upstream.json](upstream.json)：DevEco Code `0.2.4` 对应源码提交 `abc2d62370d46e7102828eb9e1f1783f0dd7474f`。完整接入需要 [deveco-code.patch](deveco-code.patch) 和本插件一起使用。

补丁包含：

- `session.turn.stopping`：根对话仍处于 busy 时等待插件审批；取消信号传递到权限等待，取消后不遗留待答请求。
- `command.execute.before` 的直接结果：用户命令进入会话记录，不触发新的模型推理。
- 插件工具的 `shellEnv()`：复用宿主 CLI 环境注入。
- 工具注册表统一覆盖顺序，附件的命名 `read` 入口也使用插件版本；模型名称不再隐藏插件提供的文件工具。
- Web / TUI 专用“审核修改”面板：审核模式、逐文件增删摘要，以及“接受 / 回滚”操作；保留宿主自动接受策略。
- TUI 和共享 Web UI 的写入差异，以及 `shell`、`spec_write` 原生卡片映射。

自动接受逻辑保持原样。DevEco CLI 本体不需要修改：AI 通过 Deltabox shell 启动 CLI，项目内的生成文件和命令修改由同一审阅范围管理。

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
# 保留宿主自动接受模式
node /absolute/path/to/deveco-deltabox/bin/deveco-deltabox.mjs run --auto "你的任务"
```

启动器通过进程级 `DEVECO_CONFIG_CONTENT` 追加插件、关闭该定制宿主的自动升级。已有环境配置需为 JSON 对象。也可设置 `DEVECO_DELTABOX_BIN` 使用其他已应用补丁的二进制。官方 `deveco` 和用户全局配置保留原状。

## 回归测试

从宿主 `packages/opencode` 运行：

```sh
bun typecheck
bun test --isolate --timeout 30000 test/tool/registry.test.ts test/plugin/trigger.test.ts test/session/prompt.test.ts
```

从 `packages/app`、`packages/tui`、`packages/ui` 分别运行 `bun typecheck`。插件的命令和真实后端测试见上层 README。

无模型账户的完整 HTTP 对话测试使用独立临时目录和本地模拟模型。上游内部测试构建选项通过以下命令启用，输出到单独的 `.local/deveco-code-test`，正式启动器不会默认使用它：

```sh
node host/setup.mjs --source /absolute/path/to/deveco-code --test-build
DEVECO_BIN="$PWD/.local/deveco-code-test/bin/deveco" npm run test:host-e2e
```

正常构建不跳过产品协议；真实使用时沿用 DevEco 自身的确认流程。编译、设备安装、签名仍需要本地 SDK、设备和账户。
