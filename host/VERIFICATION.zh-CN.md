### 挂载适配器验证 — 2026-10-27

平台：Windows x64，已安装 WinFsp。宿主固定版本未变。本节之后的记录对应 2026-10-21 的旧构建及其行为。

- npm test：46 项通过。打包预览包含适配器源码和双语图文指导。
- 干净的固定版本源码：补丁检查、冻结依赖安装、宿主包类型检查及完整测试宿主构建通过。
- 宿主挂载语言服务、插件和审核测试：17 项通过（106 条断言），通过 DEVECO_TEST_DELTABOX_NATIVE=1 验证真实 Lite 格式化、诊断、提交及回滚。
- 编译后的宿主：本地模型单轮冒烟通过。设置 DEVECO_E2E_KEEP=1 后，test:bundled-host 通过，检查了 Formatter 和 LSP 的私有视图工作目录，以及接受后的 write/edit/patch 文件内容。
- Windows 限制：较广的多轮 HTTP 测试在清理临时目录时出现 EBUSY；聚焦测试未保留临时目录时也曾超时。这些结果不计为完整套件通过，清理问题仍需排查。
- 适配器 SHA-256：4d575094aad60d5259b67bbc9712474c4cceea4974b503ee64ab63a3f8edb6fc；补丁 SHA-256：f32e2014277a57ef9db6943dd2a6b218e7e172ef3413c38c1c138022d603a427。

当前内置适配器需显式执行 /sandbox-commit 或 /sandbox-abort，--auto 也不会自动接受修改。旧外部入口保留原有功能。未修改原生 LSP、Formatter 目录，也未新增语言服务插件 API。本次未重复历史浏览器、macOS、设备及 SDK 验证。

 DevEco Code 接入验证记录

[English](VERIFICATION.md) | 简体中文

验证日期：2026-10-21，macOS arm64。

## 构建来源

- 宿主源码：`https://gitcode.com/openharmony-sig/deveco-code.git`，提交 `abc2d62370d46e7102828eb9e1f1783f0dd7474f`，对应 DevEco Code `0.2.4`、插件 API `1.17.9`。
- 本机已安装的 DevEco CLI：`1.3.9`；未替换全局 `deveco` 或 `devecocli`。
- Deltabox：分别使用 Deltabox Lite 项目的 release 构建及 npm `deltabox-lite@0.1.2` 验证。
- 构建工具：Node.js `24.9.0`、Bun `1.4.3`。
- [宿主补丁](deveco-code.patch)在原始上游文件上通过 `git apply --check`，应用后的 18 个文件与构建源码逐字节一致。补丁摘要记录在本地发行包的 `deltabox-build.json` 中。

正式发行包位于 `../.local/deveco-code`，内部测试发行包位于 `../.local/deveco-code-test`。正式构建包含 Web UI，保留产品协议流程；测试包使用上游内部测试选项，启动器默认选择正式包。

## 验证结果

| 范围 | 结果 | 实际检查内容 |
| --- | --- | --- |
| 插件单元测试 | 42 通过 | 宿主能力检查、审阅生命周期、三种审核时机、只读差异查看不提前审批、权限事件、取消、队列、传输故障、补丁校验、文件内容版本检查 |
| Deltabox 源码构建集成 | 12 通过，1 跳过 | 3 种传输 × 3 种文件系统模式、提交/回滚/清理、符号链接越界拒绝、私有会话快照刷新；可选 CLI 测试未启用 |
| npm Deltabox 集成 | 12 通过，1 跳过 | 同一真实后端矩阵；CLI 已实际启动，脚手架测试因缺少 SDK 跳过 |
| 宿主工具注册表及插件回归 | 16 通过 | 覆盖工具去重、附件 read 使用插件、不同模型可使用自定义文件工具、插件触发 |
| 宿主原有 prompt 回归 | 62 通过，1 上游跳过 | 提示、取消、权限、附件、命令、后台消息等；上游关闭的 v2 projector 用例保持跳过 |
| 完整宿主 HTTP 对话 | 1 通过，包含多个场景 | 真实宿主 + 本地模型夹具 + 真实 Deltabox；接受、拒绝、取消、自动接受、前台子 Agent，以及 task / tool / risky 的实际暂停边界 |
| 正式启动器 smoke | 1 通过 | 经启动器加载插件，使用真实调试工具入口完成私有文件读写、命令、提交和回滚 |
| 类型检查 | 通过 | 插件及宿主 backend、Web app、TUI、共享 UI 包 |
| 构建与分发检查 | 通过 | 正式宿主构建、测试宿主构建、`npm pack --dry-run` |

完整宿主测试确认：

- 普通模式下，审批未完成时会话仍为 busy，私有文件尚未进入宿主目录；点击接受后落盘，拒绝后撤回。
- 取消审批后没有残留待答权限请求，修改继续保留在待审阅范围，可用用户命令查看或回滚。
- `deveco run --auto` 自动通过 Deltabox 审批并提交修改，没有额外要求手动确认。
- 前台子 Agent 与父任务共用沙箱，子 Agent 不提前提交，由父任务统一请求审批。
- `task` 在最终模型答复后统一审核两个文件；`tool` / `risky` 在每次写入后暂停，读取和无变更命令不触发额外审核。
- 文件工具输出保留原生差异 metadata；审批说明不会追加到模型工具输出。
- `/sandbox-status` 等用户命令直接产生会话结果，不增加模型请求数。
- `shell.env` 注入的含 `$()`、引号等字符的环境变量按原值传入，且可以执行本机的 DevEco CLI。

## 浏览器验证

在独立临时项目中启动真实宿主和 Web 开发页面，用本地 HTTP 模型夹具生成 write、edit、apply_patch、shell 调用，并在 Chrome 中操作。

已观察到新建文件的绿色新增行、编辑文件的红绿差异、补丁卡片、Shell 卡片，以及专用“审核修改”面板。面板显示文件数、审核模式和逐文件增删摘要，操作为“接受 / 回滚”，等待时显示“等待审核”。浏览器点击“接受”后核对三个文件均已提交；下一轮点击“回滚”后核对该轮文件不存在，之前接受的文件保留，会话恢复 idle。

以下截图展示已验证的审核界面定制前后效果。完整测试日志保留在本地。

| 修改前 | 修改后 |
| --- | --- |
| ![通用权限提示](https://raw.githubusercontent.com/delta-box/deveco-deltabox/main/docs/images/deltabox-review-before.png) | ![包含接受和回滚操作的 Deltabox 审核界面](https://raw.githubusercontent.com/delta-box/deveco-deltabox/main/docs/images/deltabox-review-after.png) |

浏览器夹具仅替换测试标签页对产品协议状态的只读查询，不调用协议接受接口，不修改用户协议状态或全局配置。没有使用外部模型账号。TUI 完成类型检查和编译；交互点击验证在 Web UI 上进行。

定制审核 UI 的最终生产页面在 Chrome 的 `1280×800` 和 `390×844` 视口通过检查：页面身份正确、非空、无框架错误覆盖层、无控制台或运行时错误，两个操作按钮完整可见且没有遮挡。Browser 插件不可用，使用 Playwright 和仓库要求的 agent-browser 验证。生产页面三次独立浏览器上下文加载，审核面板就绪中位数由 626 ms 到 538 ms。该样本仅用于排查明显退化，不代表性能提升承诺。

浏览器测试等待命令列表初始化完成后再关闭上下文。过早关闭会中断上游缓存初始化并导致后续 `/command` 返回 499；最终验证的独立实例未出现该错误。

安装器采用临时文件加重命名的方式更新二进制，避免原位覆盖正在运行的 macOS 程序后新进程遭到 SIGKILL；安装后的 `--version` 和完整宿主对话均已通过。

## 未覆盖的环境条件

本机没有可用的 DevEco Studio / Command Line Tools SDK。DevEco CLI 已在 Deltabox 内实际执行，但创建鸿蒙项目时返回缺少安装目录的错误，因此脚手架、完整编译、签名和真机安装不能算已验证。配置 `DEVECO_CLI_STUDIO_PATH` 或 `DEVECO_CLI_CLT_PATH` 后，可重新运行带 `DEVECO_CLI_BIN` 的集成测试。

累计沙箱差异通过 `/sandbox-review`、`/sandbox-diff` 查看；DevEco 的 Git 审查侧栏沿用宿主仓库视图。私有模式下未提交的文件不会提前出现在该侧栏。命令期限、前台执行和外部副作用的边界见[插件说明](../README.zh-CN.md)。
