# dsh-session-actions

[English](README.en.md) | 中文

给 DeepSeek Harness（DSH）Web 界面左侧会话列表补充三个操作。

DSH 内置的会话右键菜单只有 **重命名 / 分叉会话 / 归档会话**，且必须点行尾的 `⋯` 才能打开。本插件在不修改 DSH 源码的前提下，为这个菜单补上：

| 功能 | 触发方式 |
| --- | --- |
| **双击重命名** | 双击会话行（按钮除外），直接打开 DSH 自带的那个重命名弹窗 |
| **复制会话 ID** | 行菜单 → 复制会话 ID，菜单项原地显示"已复制" |
| **删除会话** | 行菜单 → 删除会话（红色高亮、位于归档下方），二次确认后**永久删除**磁盘数据 |

「删除会话」不同于「归档会话」：归档只是把会话从列表里隐藏，日志和记账位都保留；删除会把会话从物理存储上抹掉，**无法恢复**，因此强制弹出二次确认。

## 安装

```sh
npm install dsh-session-actions
```

然后在 DSH profile 的 `cordis.patch.yml`（例如 `$DSH_HOME/profiles/desktop/cordis.patch.yml`）里加一行 insert：

```yaml
- insert:
    - id: session-actions
      name: 'dsh-session-actions'
```

`dsh.client.platform` 已声明为 `web`，插件包同时提供宿主半边（`index.js`）和浏览器半边（`client.js`），无需构建步骤。宿主半边改动通过 profile 配置热加载生效；浏览器半边在刷新页面后加载。

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

- **正在使用的会话不能删。** 如果该会话在本进程里是活的（`ctx.sessions.get(id)` 命中），插件会拒绝并提示重启后再删。原因：日志写入方还持有打开的文件句柄，会话对象也已被 Agent 以进程级生命周期登记；此时 unlink 日志会留下一个"内存里还在、磁盘上已没了"的幽灵行，比拒绝更难收拾。
- **工作区记录的摘除可能被回滚。** 插件是直接改 `workspace.json`，而 Workspace registry 在内存里另有一份状态，它下次写入（归档、排序等）会整份覆盖。回滚后的残留是一个指向"已不存在的会话"的 ID，任何分组视图都不会渲染它。宿主的会话索引本身有对账逻辑（`session-query-sqlite` 每次读都会与磁盘比对），所以列表不会残留幽灵行。
- **依赖渲染后的 DOM。** 会话行菜单没有任何插件扩展点（`SessionNodeItem` 内联构造 `Menu` 的 items），因此浏览器半边是在菜单渲染出来之后往上贴两行。会话 ID 不是从 DOM 文本猜的，而是沿 React fiber 读回该行自己的 props（`node` / `onRename` / `onArchive`）；这些属性名在打包产物中未被混淆。若将来 DSH 改变行组件的 props 命名，插件会退化成"什么都不加"，而不是删错会话。
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
- `test/plugin.test.mjs` —— 假 Cordis context，覆盖信任栅栏、请求校验、活跃会话拒绝；
- `test/client.test.mjs` —— 自建假 DOM 与一个极小的有状态 React 替身，覆盖 fiber 取 ID、双击重命名、菜单行注入、确认流程。

## 许可

MIT
