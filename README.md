# dsh-plugin-workspace-admin

**简体中文** | [English](README.en.md)

面向模型的 DeepSeek Harness **工作区管理**插件：让智能体在对话中直接读取和修改
Harness 的工作区列表本身。

MVP 范围就是侧边栏自身的工作区操作——**新增**、**重命名**、**删除**——外加用于
浏览工作区及其所拥有会话的只读辅助工具。

> **说明**：插件面向模型的文案——工具描述、参数描述、校验错误与调用标签——均为简体
> 中文；工具名与 JSON 结果契约保持英文，以便调用方稳定匹配。

## 工具

| 工具 | 作用 |
| --- | --- |
| `workspace_list` | 列出全部工作区，含 id、标题、目录、会话数量与目录健康状态。`include_sessions: true` 会内联每个工作区的会话。 |
| `workspace_sessions` | 列出某个工作区的会话，按时间倒序：id、由日志折叠出的标题、创建时间与谱系信息（`cwd`、父会话、子智能体深度、智能体预设）。默认排除已归档会话，除非 `include_archived: true`；`limit` 限制返回条数。 |
| `workspace_resolve` | 把绝对目录路径映射到对应的工作区条目（未注册时返回 `null`）。 |
| `workspace_create` | 把目录加入工作区列表（即侧边栏的 “Add workspace” 操作）。目录不存在时默认先创建，除非 `create_directory: false`。 |
| `workspace_rename` | 重命名某个工作区条目，只改变显示标题。 |
| `workspace_delete` | 删除某个工作区条目（即侧边栏的删除操作）。**目录与所有会话日志都会保留**，之后可以重新加回。 |

用 `id`（来自 `workspace_list`）标识工作区；在无歧义时也可以用绝对 `path`。

## 会话数据从哪来

工作区记录只存会话 **id**。标题与元数据来自其他 Harness 服务，插件读取它们，而不是
重新解析日志：

- `sessionQuery.readTitleSnapshots(ids)` 在一次观测中为一整批会话折叠出由日志支撑的
  标题事件；从未命名的会话返回 `title: null`。
- `sessionPersistence.stat(id)` 提供 header：创建时间、`cwd`、`parentSession`、
  `origin`/`delegationDepth` 和 `agentPreset`。
- `workspaceRegistry.archivedSessionIds` 是注册表全局的归档集合。

失败被**按会话隔离**：某个日志不可读时，只在该条目上出现 `unavailable` /
`metadataUnavailable`，而不是让整个列表失败。排序依据是会话创建时间，`limit` 在该
排序*之后*应用，因此返回的确实是「最新的 N 个」。

## 工作原理

插件不持有任何状态。`workspaceRegistry` 与侧边栏、`ctx.remote.workspace` Remote
命名空间、REST 控制器使用的是同一个持久服务，所以所有界面都收敛到
`$DSH_HOME/storages/workspace.json` 这一个注册表。

```
index.js                  插件入口：name / inject / apply
src/workspace-tools.js    六个原始 ToolDefinition 对象
test/harness.mjs          基于伪注册表的离线断言（不随包发布）
cordis.patch.yml          挂载该行的 bundle 层
CHANGELOG.md              发布历史（Keep a Changelog + SemVer）
LICENSE                   MIT
```

两个刻意的设计选择：

- **零裸导入。** 每个工具都是原始 `ToolDefinition`，而不是 `defineTool` 调用，因此
  插件除了 `node:` 内置模块和一个相对模块外不导入任何东西。这让它无需 DSH peer
  依赖即可安装，也能从任意绝对路径加载而不需要 profile 的 `node_modules`——这正是
  本地开发挂载得以成立的原因。
- **没有 `Config` schema。** 原生 Schemastery schema 需要裸导入；这些工具没有任何
  随部署变化的设置，所以插件不导出 Config。等真正出现可调项时再加。

## 已知限制

- **会话日志不可读。** 日志读不出来的会话仍会出现在列表里，只是 `title: null`、
  `createdAt: null`，并附带说明原因的 `unavailable` 字段。当前这个 Harness home 里
  就有真实例子：一个 pre-v1 存储，文件内容只有
  `{"type":"session","version":0,...}`，`v0-to-v1` 迁移器拒绝处理它，因此无法为它
  折叠出标题或 header。之所以报告而不是隐藏该条目，是因为工作区仍然把它计入账内，
  用户可能想对它做处理。
- **会话标题不一定有意义。** `titleSource: "fallback"` 表示标题由首条提示的启发式
  规则生成，可能只是开场消息被截断的片段，而不是摘要。

## 安装

### 作为 bundle（可分发的形态）

本包是一个 **dsh bundle**：`package.json` 声明了 `dsh.bundle.patch`，
[`cordis.patch.yml`](cordis.patch.yml) 插入挂载插件的行。因此安装它既加入依赖，也
激活该层：

```sh
# 从 registry
dsh plugin --profile web add dsh-plugin-workspace-admin

# 从本地检出、tarball 或 git 托管
dsh plugin --profile web add ./dsh-plugin-workspace-admin
dsh plugin --profile web add ./dsh-plugin-workspace-admin-0.1.1.tgz
dsh plugin --profile web add github:luoyu3rd/dsh-plugin-workspace-admin
```

`dsh plugin` 会在 profile 内部转发给 pnpm，然后把该包追加到 `dsh.profile.bundles`。
先只校验配置不启动，再启动：

```sh
dsh --profile web --dump-config | grep -A2 dsh-plugin-workspace-admin
dsh --profile web
```

卸载：`dsh plugin --profile web remove dsh-plugin-workspace-admin`。

patch 行用的是包名（`name: "dsh-plugin-workspace-admin"`）而不是文件路径。对已安装的
bundle 这是必需的：Loader 从 profile 目录及其 `node_modules` 解析模块名，而 pnpm 正是
把包提升到那里。

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:luoyu3rd/dsh-plugin-workspace-admin
```

git 安装拉取的是**源码而非构建产物**，因此不会运行包的 `build` 脚本——这正是 Harness
发布指南（`docs/user/develop/basic/publish.md`）对 git 安装给出警告的原因。本包通过
完全没有构建步骤绕开了这一切：入口就是签入仓库的 `.js` 文件，所以经由 git 到达的内容
与 Loader 导入的内容完全一致。具体来说，因为没有 `scripts.prepare`，pnpm 没有需要放行
的脚本，首次 `add` 就会成功，而不会以构建权限错误告终。

这也意味着未锁定版本的 git 安装会跟随默认分支：之后任何一次 push 都会改变用户实际
运行的内容。**锁定 commit** 才能让安装可复现：

```sh
dsh plugin --profile web add github:luoyu3rd/dsh-plugin-workspace-admin#<full-sha>
```

用 `git rev-parse HEAD` 取得 SHA。用 tag 也可以（`...#v0.1.1`），但只有 SHA 是唯一不
可被移动的形式。

### 本地开发（绝对路径）

要在原地迭代源码，改为按绝对路径挂载——Loader 直接导入该文件，不需要安装：

```yaml
- insert:
    - id: tool-workspace-admin
      name: "/absolute/path/to/dsh-plugin-workspace-admin/index.js"
```

路径必须**是绝对的**：patch 文件只提供配置，不会改变 Loader 解析模块名所用的 profile
目录。

## 发布

### 到 GitHub（git 安装）

本包已经是一个 git 仓库，发布为
[`luoyu3rd/dsh-plugin-workspace-admin`](https://github.com/luoyu3rd/dsh-plugin-workspace-admin)。
git 安装需要的就这些——不需要 registry、不需要 CI、不需要构建产物：

```sh
git init -b main
git add -A
git commit -m "feat: workspace administration tools"
gh repo create dsh-plugin-workspace-admin --public --source=. --remote=origin --push
```

后续发版时，改 `package.json` 里的 `version`，提交并 push——然后打 tag，让安装可以
锁定一个稳定的名字：

```sh
git tag v0.2.0 && git push --tags
```

因为签入的 `.js` 文件*就是*发布产物，一次 push 之后提交即可安装。没有会被遗忘的发布
步骤，仓库也不可能与用户实际运行的内容产生偏差。

### 到 npm

```sh
pnpm pack          # → dsh-plugin-workspace-admin-0.1.1.tgz（8 个文件，约 16 KB）
npm publish        # 或：npm publish --access public（用于 scoped 名称）
```

有两点让这个包无论走哪条路都异常容易发布：

- **没有构建步骤。** 源码是纯 ESM JavaScript 而非 TypeScript，所以
  `main: "index.js"` 原样发布。没有 `lib/` 需要构建，也没有 `prepare` 脚本——这正是
  git 安装（`dsh plugin add github:<owner>/<repo>`）无需 pnpm 构建放行即可工作的原因。
- **不导入 DSH。** 插件只导入 `node:` 内置模块和一个相对模块；每个工具都是原始
  `ToolDefinition`，而不是 `defineTool` 调用。因此它没有声明任何 `dependencies`，也
  没有对 `@deepseek-ai/dsh*` 的 `peerDependencies`。

最后一点也正是没有兼容性闸门的原因。启动器的 `evaluatePluginCompatibility` 检查只查看
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 `peerDependencies` 条目；由于一个都没有
声明，该检查提前返回，任何运行时都会接受这个 bundle。代价是：未来某个 Harness 版本若
改动这些服务契约，会在**运行时**而非安装时报错——所以如果你之后加入了 `defineTool`
导入或 Schemastery `Config`，请同时声明对应的 `peerDependencies`。

## 修改插件

Loader 每个进程只导入一次插件模块（以 URL 为键），所以**修改这些文件不会在正在运行的
profile 中生效**——改 patch 文件也不行，它只负责同步行。改动插件源码后请重启 profile
（桌面应用：退出并重新打开）。

相比之下，patch 文件的修改是实时同步的。

## 测试

```sh
node test/harness.mjs
```

用真实的工具定义跑一遍工作区注册表的内存伪实现：注册形态、输出信封、参数校验、幂等
create、递归创建目录、按 id 与按 path 重命名、delete、删除后重新添加、会话列表、
归档过滤、`limit` 截断，以及按会话降级。

## 许可证

[MIT](LICENSE) © 2026 luoyu3rd
