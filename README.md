# dsh-session-actions

[English](README.en.md) | 中文

给 DeepSeek Harness（DSH）Web 界面左侧会话列表补充操作。

DSH 内置的会话菜单只有 **重命名 / 分叉会话 / 归档会话**，且必须点行尾的 `⋯` 才能打开。本插件在不修改 DSH 源码的前提下，为这个菜单补上：

| 功能 | 触发方式 |
| --- | --- |
| **右键打开菜单** | 在会话行任意位置点右键，弹出 DSH 自带的那一个菜单（重命名 / 分叉 / 归档 + 本插件的两项） |
| **双击重命名** | 双击会话行（按钮除外），直接打开 DSH 自带的那个重命名弹窗 |
| **复制会话 ID** | 行菜单 → 复制会话 ID，写入剪贴板后菜单自动关闭（复制失败则保留菜单，可重试） |
| **删除会话** | 行菜单 → 删除会话（红色高亮、位于归档下方），二次确认后**永久删除**磁盘数据，该行随即从列表消失 |

「删除会话」不同于「归档会话」：归档只是把会话从列表里隐藏，日志和记账位都保留；删除会把会话从物理存储上抹掉，**无法恢复**，因此强制弹出二次确认。

删除成功后，浏览器半边会直接调用会话列表自己的移除入口（`sessions.handleSessionRemoved`，也就是宿主 `api-session/removed` 事件所调用的同一个方法），行立即消失——**不再重新拉取列表**，因为那次拉取会把宿主当前基线合并回来，任何宿主仍在报告的会话都会跟着回来。宿主半边同时也会广播官方的 `api-session/removed`，作为同一条通路的冗余信号。如果删掉的恰好是**当前打开着**的那个会话，选择会先被清空（回到"没有会话"的空态），聊天面板不会继续显示一个已经不存在的会话。

## 安装

本包是一个 **DSH bundle**（`package.json` 里声明了 `dsh.bundle.patch` → 包内的 `cordis.patch.yml`）。因此有两种装法，**二选一，不要同时用**：

**推荐：作为 bundle 安装**（社区市场 / 插件管理器点「安装」，或手动）

```sh
dsh plugin --profile desktop add dsh-session-actions
```

装好后该包会出现在 profile 的 `dsh.profile.bundles` 里，它的 patch 层会在启动时自动插入 Loader 行，不需要你再改任何文件。市场安装前会从 npm 校验这个包确实声明了 `dsh.bundle.patch`，缺少声明会被直接拒绝。

**或者：手动加一行 insert**（profile 不用 bundles 的场合）

在 DSH profile 的 `cordis.patch.yml`（例如 `$DSH_HOME/profiles/desktop/cordis.patch.yml`）里加：

```yaml
- insert:
    - id: session-actions
      name: 'dsh-session-actions'
```

⚠️ 如果 profile 已经把本包装进 `dsh.profile.bundles`，就**不要**再写这行 insert —— 那会把插件加载两次（宿主半边会因路由重复注册报错，界面上的菜单项也会重复）。

`dsh.client.platform` 已声明为 `web`，插件包同时提供宿主半边（`index.js`）和浏览器半边（`client.js`），无需构建步骤。

两半都在**应用启动时**装载：浏览器半边的代码字节是启动时快照的，宿主半边是启动时求值的，而 DSH Desktop 当前构建的 HMR 不可用（日志会报 `[hmr] Error: --expose-internals is required for HMR service`）。因此升级插件版本后需要**重启 DSH**，仅刷新页面不够。

## 它到底删了什么

删除是按照 DSH 实际的存储布局进行的，逐个会话地清掉这些：

```
$DSH_HOME/sessions/<工程目录键>/<会话 ID>/session.v<N>.jsonl.zstd   会话日志（含锁文件与同目录其他产物）
$DSH_HOME/storages/session_projcache/sessions/<会话 ID>.json        投影缓存
$DSH_HOME/storages/workspace.json                                   从 archivedSessionIds[] 与
                                                                    各 workspaces[*].sessionIds[] 中摘除该 ID
```

工程目录键（`projectKey`）是有损编码（分隔符折叠、超长截断），无法由会话 ID 反推，因此插件是**扫描** `sessions/` 下每个工程桶来定位会话目录，而不是重算路径。这样即使会话头读不出来也能删掉。

**附件不会删。** `$DSH_HOME/attachments/v1/objects/` 里是按内容寻址（sha256 分片）的对象，多个会话可能共享同一份，按会话删除会误伤其他会话，所以插件不碰它。确认弹窗里也写明了这一点。

## 已知限制

- **正在运行的会话不能删。** 判定用的是 DSH 自己的 `agent/status`：只要该会话的 Agent 正在跑一个回合（`ctx.agents.get(id).status === 'running'`），插件就拒绝删除，因为那一轮还在往日志里追加内容，删掉等于同时丢掉问题和答案。**只是打开着、但没在跑的会话可以正常删除**：文件会被清掉，列表行也会随之消失。
  - 代价要说清楚：已被本进程装载（attached）的会话，其内存对象由创建它的 fiber 持有，插件没有处置它的权限（`AgentHandle.dispose()` 只给创建者）。所以删除一个"打开着的空闲会话"之后，进程内还会留着它的副本，直到你**重启 DSH** 才彻底释放。磁盘和列表都已经干净，重启前也不会再产生新的日志内容。
- **工作区记录的摘除可能被回滚。** 插件是直接改 `workspace.json`，而 Workspace registry 在内存里另有一份状态，它下次写入（归档、排序等）会整份覆盖。回滚后的残留是一个指向"已不存在的会话"的 ID，任何分组视图都不会渲染它。宿主的会话索引本身有对账逻辑（`session-query-sqlite` 每次读都会与磁盘比对），所以列表不会残留幽灵行。
- **依赖渲染后的 DOM。** 会话行菜单没有任何插件扩展点（`SessionNodeItem` 内联构造 `Menu` 的 items），因此浏览器半边是在菜单渲染出来之后往上贴两行；右键也是**按下该行自己渲染的那个 `⋯` 按钮**来开菜单，而不是另建一个菜单。贴完两行后会按菜单的**真实高度**重新定位一次：下方放不下就翻到触发按钮上方，四周保留 12px 边距（与 DSH 自己的定位规则一致），滚动/缩放时再补一次——否则窗口较矮时，追加的两行会落到窗口下沿之外。会话 ID 不是从 DOM 文本猜的，而是沿 React fiber 读回该行自己的 props（`node` / `onRename` / `onArchive`）；这些属性名在打包产物中未被混淆。若将来 DSH 改变行组件的 props 命名，插件会退化成"什么都不加"，而不是删错会话。
- 只对 Web 界面生效。无头 profile 下宿主半边加载为空操作。

## 安全

`/api2/dsh-session-actions/*` 是一个自建的 JSON 接口，不走 DSH 官方 `/api` 通道（那是代码生成的 Remote 装配，树外插件没有席位）。因为它是破坏性接口，所以带了三重栅栏，与另一处插件自建接口一致：

1. 只接受 `POST`；
2. 只接受 `application/json`（跨站页面无法在不触发 CORS 预检的前提下发出该 Content-Type，而本路由不响应预检）；
3. 只接受回环 `Host`（可用环境变量 `DSH_SESSION_ACTIONS_TRUSTED_HOSTS` 追加受信主机名，逗号分隔）。

会话 ID 在拼进路径前按 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` 校验，路径段再做一次与存储后端一致的转义，并在拼接后复核结果仍在 sessions 根目录之下。

## 开发

```sh
node --test 'test/*.test.mjs'
```

零依赖，用 `node:test`。测试分三层：

- `test/session-files.test.mjs` —— 真实文件系统（临时目录里搭出与 DSH 一致的存储布局），断言删除后磁盘上剩下什么；
- `test/plugin.test.mjs` —— 假 Cordis context，覆盖信任栅栏、请求校验、运行中会话拒绝、删除后的 `api-session/removed` 广播；
- `test/client.test.mjs` —— 自建假 DOM 与一个极小的有状态 React 替身，覆盖 fiber 取 ID、双击重命名、右键开菜单、菜单行注入与重新定位、复制后关闭菜单、确认流程与删除后的列表移除。

## 许可

MIT
