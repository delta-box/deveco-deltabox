# Deveco DeltaboxLite 集成使用指导

[English](deltabox.md) | 简体中文

> 代码位于 [DevEco Code MR \!1334](https://gitcode.com/openharmony-sig/deveco-code/merge_requests/1334)

DeltaBox Lite 是专为 AI Agent 打造的轻量级文件系统运行时，提供变更对比、提交和回滚文件系统状态的功能，并且支持文件系统的隔离。

`deveco-deltabox`插件通过接管 Deveco 内置的文件读写、编辑、查找、补丁和 shell 工具，使改动写入DeltaBox Lite的专属工作区，来获得上述变更对比、提交和回滚文件系统状态的能力。

添加插件后，DevEco Code 在完成一轮对话时，会先列出本轮修改。你可以通过命令接受全部修改，也可以将项目文件回滚到本轮修改前的状态。

## 环境要求

- 使用 Windows 版本前需要安装 [WinFsp](https://winfsp.dev)

- 使用 MacOS 版本无需安装额外应用

## 快速开始

### 启用 Deltabox

在项目根目录的 `deveco.jsonc` 中加入以下配置：

```jsonc
{
  "deltabox": true,
}
```

如需对所有项目启用，请改为编辑用户配置：

```text
~/.config/deveco/deveco.jsonc
```

修改配置后，完全退出并重新启动 DevEco Code。

### 检查启用状态

安装并启用DeltaBox后，可以通过以下命令检查安装是否成功

进入项目后执行：

```text
/sandbox-status
```

![使用示例](images/deltabox/tui-status-command.png)

![使用示例](images/deltabox/gui-status-command.png)

![使用示例](images/deltabox/tui-status-output.png)

![使用示例](images/deltabox/gui-status-output.png)

输出中应包含当前会话、项目路径、审核模式、文件系统模式和待审核修改数。首次启动时，待审核修改数应为 `0`。

### 关闭 Deltabox

关闭前，先接受或回滚所有待审核修改。然后将配置改为：

```jsonc
{
  "deltabox": false,
}
```

重新启动 DevEco Code 后，配置生效。

## 模式说明

### 文件系统模式

DeltaBox Lite 支持三种文件系统工作模式。

| 模式            | 待审核修改的可见性 | 行为                                                                 |
| --------------- | ------------------ | -------------------------------------------------------------------- |
| `cbcow-through` | 立即对宿主可见     | 直接修改项目并记录回滚数据。接受速度快，但其他进程能看到待审核内容。 |
| `cbcow-private` | 接受前不可见       | 在私有视图中修改。接受时只发布已修改路径。需要平台原生文件系统支持。 |
| `copy-private`  | 接受前不可见       | 复制项目到私有工作区。兼容性较好，但大型项目的复制成本更高。         |

默认模式为`cbcow-through`。在该模式下，Agent 对宿主工作区的改动即时生效。在其余两种模式下，Agent 写入 DeltaBox Lite 管理的私有工作区，提交后才会写入宿主工作区。

### 持久化级别

- `fast`：默认值。减少同步写入开销，获得更高性能。

- `strict`：增加事务机制，得到更强的一致性保证。只有部分平台和原生 CB\-CoW 模式支持。

## 常用命令

| 命令                            | 作用                                              |
| ------------------------------- | ------------------------------------------------- |
| `/sandbox-status`               | 查看会话、文件系统和待审核修改状态。              |
| `/sandbox-review`               | 查看全部待审核修改。该命令不会触发接受或回滚。    |
| `/sandbox-diff [from] [to]`     | 查看指定检查点之间的差异。参数可以省略。          |
| `/sandbox-commit`               | 接受全部待审核修改。                              |
| `/sandbox-abort`                | 回滚当前审核范围内的项目文件修改。                |
| `/sandbox-skip`                 | 暂不处理，并保留待审核修改和原始回滚点。          |
| `/sandbox-mode task`            | 在根任务结束后统一审核。默认使用此模式。          |
| `/sandbox-mode tool`            | 在修改工具执行后审核实际文件修改。                |
| `/sandbox-mode risky`<br>       | 在风险工具执行后审核实际文件修改。                |
| `/sandbox-confirmation command` | 每轮对话结束后使用`/sandbox-commit`等指令处理提交 |
| `/sandbox-confirmation dialog`  | 每轮对话或工具调用结束时出现弹窗要求确认          |

## 使用示例

向 DevEco Code 发送一个会修改项目文件的任务。例如：

```text
在当前项目中新建 deltabox-demo.txt，写入 Deltabox is enabled。
```

![使用示例](images/deltabox/tui-create-demo-file.png)

任务完成后，可以执行以下命令查看工作区内改动：

```text
/sandbox-review
```

也可以执行：

```text
/sandbox-diff
```

![使用示例](images/deltabox/tui-review-diff.png)

执行`/sandbox-commit`可以保留本轮改动

![使用示例](images/deltabox/tui-commit-changes.png)

执行`/sandbox-abort`可以撤销本轮改动

![使用示例](images/deltabox/tui-abort-changes.png)

执行

```text
/sandbox-confirmation dialog
```

可以将审批方式切换为审批栏模式，模型完成本轮回复后，界面会显示“审核修改（Review changes）”。

![使用示例](images/deltabox/tui-review-dialog.png)

![使用示例](images/deltabox/gui-review-dialog.png)

点击“接受（Accept）”，Deltabox 会保留本轮的全部项目文件修改；点击“回滚（Roll back）”，Deltabox 会恢复本轮修改涉及的项目文件。

## 高级配置

高级设置放在项目根目录的 `deltabox.json` 中。也可以使用用户配置：

```text
$XDG_CONFIG_HOME/deveco/deltabox.json
```

未设置 `XDG_CONFIG_HOME` 时，默认路径是 `~/.config/deveco/deltabox.json`。

DevEco Code 先读取用户配置，再读取项目配置。项目配置覆盖用户配置中的同名字段。

### 完整默认值

`deltabox.json` 的默认值如下：

```jsonc
{
  "transport": "native", // 使用Node-API通信（推荐，速度快）
  "bin": "deltabox", // Deltabox可执行文件；此默认值会解析到随包提供的程序，也可指定自定义路径
  "nativeAddon": null, // 自定义Node-API扩展（.node文件）路径；随包提供，无需改动
  "policy": null, // 沙箱策略文件路径，用于配置文件访问、网络和资源限制；null=使用运行时默认策略
  "stateDir": null, // 持久状态目录，保存会话、检查点、日志和回滚数据；null=使用运行时默认位置
  "runtimeDir": null, // 运行时工作目录，用于临时工作区等资源；null=使用运行时默认位置
  "trusted": false, // 是否信任命令执行：false=启用命令隔离；true=native方式下使用宿主执行环境，不等于自动接受修改
  "timeoutMs": 660000, // cli/serve 模式下的超时时延，不适用于该插件
  "filesystem": {
    "mode": "auto", // 文件系统模式
    "require": false, // 是否强制要求指定的文件系统模式
    "durability": "fast", // 持久化策略
    "groupCommitMs": null, // 规定时间内对多个写入的持久化同步操作进行合并，单位毫秒；
  },
  "review": {
    "mode": "task", // 审核时机：task=本轮结束；tool=修改工具执行后；risky=当前适配器中与tool相同
  },
}
```

### 配置审核时机

`review.mode` 支持以下值：

| 值      | 行为                                                                |
| ------- | ------------------------------------------------------------------- |
| `task`  | 根任务结束后统一审核。模型、工具和前台子 Agent 完成后显示一次审核。 |
| `tool`  | 每个可能修改项目的工具结束后检查差异。有实际修改时显示审核。        |
| `risky` | 按风险工具边界审核。当前实现与`tool`边界一致。                      |

例如，每次修改后立即审核：

```jsonc
{
  "review": {
    "mode": "tool",
  },
}
```

也可以在当前会话中执行 `/sandbox-mode task|tool|risky`。该命令不会修改配置文件。

### 配置文件系统模式

`filesystem.mode` 支持以下值：

| 值              | 待审核修改的可见性 | 行为                                                                              |
| --------------- | ------------------ | --------------------------------------------------------------------------------- |
| `auto`          | 取决于实际模式     | 让 Deltabox 选择可用模式。不可用时允许回退。使用 `/sandbox-status` 查看实际模式。 |
| `cbcow-through` | 立即对宿主可见     | 直接修改项目并记录回滚数据。接受速度快，但其他进程能看到待审核内容。              |
| `cbcow-private` | 接受前不可见       | 在私有视图中修改。接受时只发布已修改路径。需要平台原生文件系统支持。              |
| `copy-private`  | 接受前不可见       | 复制项目到私有工作区。兼容性较好，但大型项目的复制成本更高。                      |

`filesystem.require` 控制模式回退：

- `false`：请求的模式不可用时，允许 Deltabox 回退到其他模式。

- `true`：请求的模式不可用时，启动失败。Deltabox 不会回退。

`filesystem.durability` 控制持久化级别：

- `fast`：默认值。减少同步写入，保留常规会话恢复能力。

- `strict`：增加事务机制，得到更强的一致性。只有部分平台和原生 CB\-CoW 模式支持。

`filesystem.groupCommitMs` 接受正整数或 `null`，单位为毫秒。开启后允许把规定时间内多个写入的持久化同步操作（如`fsync`）进行合并，减少磁盘同步开销。

## 使用限制

- 启用后，内置 Git 快照功能会关闭。

- shell 命令必须以前台方式运行，最长运行时间为 600 秒。

- shell 不支持 PTY、标准输入或后台任务。

- Windows shell 使用 PowerShell 语法。macOS 和 Linux 使用 Bash 语法。
