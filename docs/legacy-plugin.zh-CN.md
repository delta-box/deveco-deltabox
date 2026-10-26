# DevEco Code + Deltabox

[English](legacy-plugin.md) | 简体中文

让 DevEco Code 的 AI 文件操作和命令使用 Deltabox 的同一个工作视图，支持查看差异、接受修改和回滚。

接入对象是 AI 编程终端 [DevEco Code](https://gitcode.com/openharmony-sig/deveco-code)（`deveco`）。[DevEco CLI](https://gitcode.com/openharmony-sig/deveco-cli)（`devecocli`）是鸿蒙工具链，可由 AI 通过本插件的 `shell` 调用。

## 安装

需要插件和配套的 DevEco Code 宿主补丁，尚未发布 npm 包。现成的官方 `0.2.4` 不具备完整的结束审批钩子；插件会拒绝在缺少所需能力的宿主上执行项目工具。克隆本仓库并构建：

```sh
git clone https://github.com/delta-box/deveco-deltabox.git
cd deveco-deltabox
npm ci
npm run build
npm run setup:host
```

构建需要 Git、Node.js 22+、Bun 1.4.2+ 和网络。脚本固定上游提交并应用补丁，生成带 Web UI 的宿主。参见 [宿主构建与补丁](../host/README.zh-CN.md)。然后在目标项目目录运行：

```sh
node /absolute/path/to/deveco-deltabox/bin/deveco-deltabox.mjs
```

启动器自动加载插件，沿用原有模型、账户和权限设置；不会替换系统安装的 `deveco` 或 `devecocli`。若自行运行已打补丁的宿主，也可在目标项目 `deveco.jsonc` 中手动加入插件的**绝对路径**，并放在插件列表末尾：

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/deveco-deltabox/dist/plugin.js"
  ]
}
```

执行 `/sandbox-status` 检查后端和实际文件系统模式。插件依赖会安装对应平台的 Deltabox 原生模块和可执行文件。默认 `native` 传输不需要另外启动服务。

`glob`、`grep` 需要 `rg` 在 PATH 中。沙箱 shell 会调用宿主的 `shell.env` 流程，保留工具链 PATH、认证来源和其他环境注入，并通过结构化参数传给 Deltabox。宿主通常优先使用其自带的 CLI；也可在 shell 中调用已安装 `devecocli` 的绝对路径。SDK、Java 等路径仍按 [DevEco CLI 官方说明](https://gitcode.com/openharmony-sig/deveco-cli)配置。

支持 macOS，也接受 Linux 和 Windows 上的兼容宿主。插件采用 DevEco 的 `@opencode-ai/plugin` 接口，接口依赖固定为 `1.17.9`。

## 与 Pi / DeepSeek Harness 对齐的能力

| 能力 | DevEco 接入 |
| --- | --- |
| 文件读写和修改 | 覆盖 `read`、`write`、`edit`、`spec_write`，原生传输使用 Buffer |
| 文件一致性 | 已观察文件的内容版本检查；覆盖现有文件前须读取；外部或 shell 修改后须重新读取 |
| 命令 | 覆盖当前的 `shell` 和旧版 `bash`，通过 Deltabox 执行 |
| 查找 | `glob`、`grep`、`find`、`list` / `ls` 使用同一沙箱视图 |
| 多文件补丁 | `apply_patch` 支持新增、修改、删除、移动，写入前校验全部补丁 |
| 持久会话 | 连续工具调用复用会话；子 Agent 与父对话共享队列和审阅范围 |
| 会话交接 | 干净的直通会话可复用；私有模式释放干净的空闲会话并重新取快照；未处理或跳过的修改保持原所有者 |
| 审阅 | `task`、`tool`、`risky`，保留首次修改前的回滚点 |
| 任务结束 | 宿主等待根对话审批完成后才转为空闲；子 Agent 不提前提交共享范围 |
| 权限策略 | 普通模式等待选择；宿主自动接受模式照常提交；拒绝回滚；取消保留待审范围 |
| 原生 UI | Web / TUI 的文件差异和 shell 输出卡片；专用“审核修改”面板，显示文件摘要、审核模式和“接受 / 回滚”按钮 |
| 用户命令 | 直接返回结果，不再调用模型总结，也不向模型工具输出追加审批信息 |
| 后端 | `native`、常驻 stdio `serve`、逐次调用 `cli` |
| 文件系统 | `auto`、`cbcow-through`、`cbcow-private`、`copy-private`；支持严格持久化参数 |
| 状态 | 显示实际模式、回退原因、可见性、持久化级别和 taint 状态 |

`task` 默认在根对话的一轮完整任务结束时阻塞等待审核，即本轮模型推理、工具调用和前台子任务全部结束后统一处理，不在每条模型消息或每次写文件后弹窗；没有变更时自动关闭空审阅范围。AI 的 `sandbox_review` 只查看差异，不提前触发审批。宿主的自动接受模式保持可用。

`tool` 和 `risky` 在每次可能修改项目的工具调用完成后检查差异，有实际变更才请求审核；shell 命令一律视为可能修改。读取、搜索和没有变更的命令不弹窗。“接受”或宿主自动放行会提交当前范围，“回滚”会恢复原状。取消和审批界面故障保留待审阅状态；错误会向宿主传播。修改报错后已有的部分修改仍可审阅。

三种模式沿用 Pi / DSH 的任务与工具边界。交互上有一处区别：DSH 默认在任务结束时等待审批，Pi 默认仅提示待审阅，由用户命令提交或回滚；DevEco 采用 DSH 的等待审批方式。`tool` / `risky` 与 Pi 一样，在修改工具执行后检查变更。

与 DSH 的接入边界相同，UI 使用单次工具差异和审批摘要；累计差异通过 `/sandbox-review`、`/sandbox-diff` 查看。DevEco 的 Git 审查侧栏仍显示宿主仓库状态，私有模式下尚未提交的沙箱文件不会出现在该侧栏。

同一项目仍有未处理的原生会话时，新对话可能收到后端的项目占用错误。请回到原对话提交或回滚，再启动新的工作。

## 用户命令

| 命令 | 行为 |
| --- | --- |
| `/sandbox-status` | 查看会话、审阅模式和文件系统状态 |
| `/sandbox-review` | 显示当前待审阅差异 |
| `/sandbox-commit` | 接受当前审阅范围的全部修改 |
| `/sandbox-abort` | 回滚到当前审阅范围开始前 |
| `/sandbox-skip` | 保留待处理修改及原回滚点 |
| `/sandbox-diff [from] [to]` | 查看检查点差异 |
| `/sandbox-mode task\|tool\|risky` | 切换模式，已有待审阅范围保持不变 |

这些命令由宿主的用户命令钩子直接执行并返回结果，不调用模型。AI 只获得 `sandbox_review` 差异查看工具，没有直接提交或回滚的模型工具。

任务结束的审核面板使用“接受 / 回滚”；取消后可用上述命令继续处理。`cbcow-through` 的修改立即对宿主可见；如果需要提交前隔离文件内容，请选择私有模式。

## 配置

先读取 `$XDG_CONFIG_HOME/deveco/deltabox.json`（默认 `~/.config/deveco/deltabox.json`），再合并项目根目录的 `deltabox.json`。两层配置的 `filesystem` 和 `review` 分别合并。无效配置会阻止工具执行。

以下为默认值：

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

- `native` 使用进程内 Node-API 会话和字节 I/O。默认从 npm 依赖加载后端；`bin` 和 `nativeAddon` 可分别指定匹配版本的本地可执行文件和 `.node` 模块。兼容 Deltabox 源码构建版的旧式构造参数及已发布 0.1.2 的选项对象。
- `serve`、`cli` 使用 `bin` 指定的可执行文件（默认为 PATH 中的 `deltabox`）。通信超时后停止复用该连接，避免误判有歧义的修改结果。
- `trusted: false` 默认启用命令隔离。仅在 `native` 下，显式设置 `true` 才使用与其他适配器相同的可信执行模式，此时命令使用宿主权限。`serve` / `cli` 始终使用后端隔离。
- `policy` 指向 Deltabox 策略文件。SDK、构建缓存等额外目录及环境变量按工具链需要配置到策略中；文件回滚覆盖项目内修改。
- `stateDir`、`runtimeDir`、`policy`、`nativeAddon` 的相对路径以项目根目录为基准；状态路径会规范化 macOS 的 `/var`、`/tmp` 等别名。
- `filesystem.require: true` 禁止文件系统模式回退。严格持久化、group commit 的平台限制遵循 Deltabox 本身。

## 兼容范围

没有适配的工具会明确报错，包括 MCP 工具以及会直接调用宿主进程的鸿蒙检查、设备和截图工具。请通过沙箱 `shell` 调用相应 `devecocli` 命令。`switch_cwd`、`plan_write`、`batch` 同样禁用；`spec_write` 按普通可审阅文件写入处理，不运行宿主内置的文档校验。

插件关闭宿主 LSP、自动 formatter 和 snapshot，避免这些组件在工具适配之外写入项目。请使用 shell 中的编译、校验和格式化命令。另一个插件若再次替换相同工具，可能改变执行路径，因此应让本插件最后加载，并避免重复覆盖。插件依赖可信的 DevEco 宿主及其插件配置。

命令采用后端固定的 600 秒期限，提供前台执行接口，不提供 PTY、交互输入或后台任务控制；后台子 Agent 也会明确拒绝。UI 取消不会中断已进入原生后端的命令；队列会等待实际执行结束后再处理后续操作，已有修改保持待审阅。文件读取仅支持 UTF-8 文本和目录列表。内容版本检查避免覆盖已观察文件的变化；宿主没有 DSH 的 opaque FsTarget API，因此不暴露可跨会话复用的文件句柄。

设备安装、签名服务、网络请求等外部效果不属于项目文件回滚范围。正常关闭插件或删除所属会话时，会先回滚未接受的修改再释放资源；异常退出后的恢复使用 Deltabox 自身的会话恢复能力。

## 验证

```sh
npm test

# 使用本地构建的 Deltabox，.node 模块需与二进制匹配。
DELTABOX_BIN=/absolute/path/to/deltabox \
DELTABOX_NATIVE_ADDON=/absolute/path/to/deltabox.node \
  npm run test:integration

# 打补丁宿主的调试工具入口，无需模型账号。
DEVECO_BIN=/absolute/path/to/deveco \
  npm run test:host

# 隔离测试构建的完整对话，模型由本机 HTTP fixture 提供。
DEVECO_BIN=/absolute/path/to/test-build/deveco \
DEVECO_CLI_BIN=/absolute/path/to/devecocli \
  npm run test:host-e2e
```

集成测试在独立临时项目中验证 3 种传输 × 3 种文件系统模式的文件读写、shell、补丁、提交、跳过后回滚、退出清理，以及符号链接越界拒绝和私有快照刷新。没有配置 `DELTABOX_BIN` 时，集成测试会明确跳过。单元测试覆盖宿主钩子、审批事件、会话交接、并发、取消、传输故障和补丁校验。

完整宿主测试覆盖阻塞审批、接受、拒绝、取消、`run --auto`、原生差异 metadata、shell 环境传递，以及用户命令不调用模型。使用上游支持的内部测试构建选项；正式构建保留正常产品协议流程。浏览器测试使用独立本地模型和仅作用于测试页面的协议查询夹具，不调用协议接受接口。详见 [验证记录](../host/VERIFICATION.zh-CN.md)。

接口核对依据：[DevEco Code 源码](https://gitcode.com/openharmony-sig/deveco-code)，提交 `abc2d62370d46e7102828eb9e1f1783f0dd7474f`。实际设备构建、调试和安装仍取决于本地 SDK、设备和账号配置。

## 许可证

插件使用 [Apache-2.0](LICENSE)。DevEco Code 宿主补丁所涉及的上游代码保留 [MIT 许可证](../host/UPSTREAM-LICENSE)。
