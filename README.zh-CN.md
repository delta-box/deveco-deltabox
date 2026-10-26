# DevEco Code + Deltabox

[English](README.md) | 简体中文

让 DevEco Code 的文件操作和命令使用 Deltabox 文件系统视图，支持查看、接受和回滚修改。配套宿主构建包含适配器和固定为 `deltabox-lite@0.1.4` 的运行时。

## 构建和启动

该集成需要配套的 DevEco Code 宿主。构建需要 Git、Node.js 22+、Bun 1.4.2+ 和网络。Windows 还需要安装 [WinFsp](https://winfsp.dev)。

```sh
git clone https://github.com/delta-box/deveco-deltabox.git
cd deveco-deltabox
npm ci
npm run setup:host
```

从目标项目目录运行启动器：

```sh
node /absolute/path/to/deveco-deltabox/bin/deveco-deltabox.mjs
```

启动器通过进程内的 `DEVECO_CONFIG_CONTENT` 启用内置适配器并保留其他设置，不影响系统安装的 `deveco` 和 `devecocli`。直接运行新构建的宿主时，也可以在项目或用户的 `deveco.jsonc` 中设置 `"deltabox": true`。不要同时注册旧外部插件。

截图、命令、审核方式、文件系统模式和配置见[使用指导](docs/deltabox.zh-CN.md)，构建参数见[宿主构建说明](host/README.zh-CN.md)。

## 挂载视图中的 LSP 和格式化

在 DevEco 配置中启用 `"lsp": true` 和 `"formatter": true`，即可在 Lite 挂载视图中使用已有原生服务。写入、编辑和补丁后恢复格式化和诊断，格式化结果计入审核、接受和回滚。运行时必须提供宿主可访问的挂载点，不会回退到原项目执行。

`host/adapter/` 中的源码直接导入 DevEco 内部服务，随配套宿主一起编译。没有新增插件语言服务 API，也没有修改原生 LSP 和 Formatter 目录；宿主工具的查询函数与挂载适配器共用。构建记录包含宿主补丁和适配器源码的哈希。

包中已有的 `dist/plugin.js` 外部入口继续兼容旧版配套宿主，功能范围与此前相同。仅以外部插件方式加载它，不会获得新增的挂载语言服务。旧入口说明见[外部插件使用说明](docs/legacy-plugin.zh-CN.md)。使用当前集成请构建配套宿主并通过启动器运行。

## 验证

```sh
npm test
npm pack --dry-run
node host/setup.mjs --source /path/to/pinned/deveco-code --check
```

在宿主的 `packages/opencode` 目录运行：

```sh
bun typecheck
bun test --timeout 30000 test/plugin/deltabox.test.ts test/plugin/deltabox-language.test.ts
```

在已安装原生文件系统提供程序的机器上设置 `DEVECO_TEST_DELTABOX_NATIVE=1`，可验证真实 Lite 挂载视图中的格式化、诊断、接受和回滚。已完成检查的范围见[验证记录](host/VERIFICATION.zh-CN.md)。
