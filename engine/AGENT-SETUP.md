# 给 Agent 的接入指引

> 这份文件写给**接进来的 Agent**，不是写给人看的教程。人的安装说明在 [`README.md`](README.md)。
> 你要做的是：读环境 → 找配置落点 → 写配置 → 验证通路 → 报告结果。**自己探测，不要问用户「配置文件在哪」。**
> 接入完成后，必须再完成文末 [7. 初始化必读清单](#7-初始化必读清单) 的 6 项。

## 0. 前置事实

- 推荐入口是 `node runtime/alpha-dog-sidecar.cjs`；sidecar 包裹 `alpha_memory_bridge.js`，由 Node 侧提供 Alpha-Dog 事件源。
- 仅需要裸记忆内核时，入口仍是 `python -m md_cg.mcp_server`。
- 内核**没有任何平台依赖**：它不知道自己在哪个宿主里跑。宿主信息必须由配置注入。
- 路径只认环境变量：`MDCG_ROOT` / `MDCG_DATA_ROOT` / `MDCG_STATE_ROOT` / `ALPHA_MEMORY_HOME` / `MDCG_SESSIONS_ROOT`。
  一个都没配时落到 `~/.alpha-memory`。

## 1. 先确认内核能跑

**下列命令都在仓库的 `engine/` 目录下执行**（内核在 `engine/md_cg/`）。

```bash
cd engine
python md_cg/datapath.py
```

它打印状态根 / 数据根 / 认知图根。报错就先解决 Python 与 `PYTHONPATH`，不要往下走。

再起一次 server，看它答不答：

```bash
cd engine
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' | python -m md_cg.mcp_server
```

期望：返回一段 JSON，`result.serverInfo.name` 为 `mdcg-mcp`，
`result.capabilities` 含 `tools` 与 `resources`。

## 2. 探测宿主的配置落点

**你比任何清单都更清楚自己在哪跑**。按这个顺序探测，命中即用，不要每个都写：

1. **进程环境变量** —— 先看自己继承到的环境，找形如 `<大写名>_HOME` / `<大写名>_CONFIG` /
   `<大写名>_PROFILE` 的变量。它们指向你自己的宿主根目录，是最可靠的线索。
2. **自己从哪启动** —— 看自己的可执行文件路径和当前工作目录，向上回溯到宿主安装目录。
3. **用户目录下的 MCP 配置** —— 在 `~` 下找内容里含 `"mcpServers"` 键的配置，以及这些常见文件名：
   `.mcp.json`、`mcp.json`、`mcp_servers.json`。
4. **项目级配置** —— 当前工作目录及各级父目录下的同名文件。

命中的文件里应该已有、或者可以新增一个 `mcpServers` 配置块。

一个都没命中时：**不要编造路径写进去**。把探测到的环境变量、目录与候选清单列给用户，
让他指定——他比你知道自己的宿主装在哪。

## 3. 写配置

```json
{
  "mcpServers": {
    "alpha-memory": {
      "command": "node",
      "args": ["<Alpha-Memory>/engine/runtime/alpha-dog-sidecar.cjs"],
      "env": {
        "ALPHA_MEMORY_HOME": "<Alpha-Memory>",
        "SIDECAR_MODE": "wake",
        "SIDECAR_NETWORK": "off",
        "MDCG_ROOT": "<记忆目录绝对路径>"
      }
    }
  }
}
```

- `ALPHA_MEMORY_HOME` 必须指向包含根目录 `alpha_memory_bridge.js` 与 `engine/` 的绝对路径；sidecar 会自动包裹 bridge，不要把 command 改成裸 Python。
- **不要手抄路径**：先在 `alpha-dog.setting.json` 的 `sidecar` 块里定好入口，再跑 `npm run mcp:config` 拿现成的 `mcpServers` 块。该命令只读配置，不启动任何进程。
- `SIDECAR_MODE=wake` 才在档口调用 Alpha-Dog runtime；`observe` 只记录；`SIDECAR_NETWORK=off` 是默认本地网络闸。
- `Alpha_Dog_On` 后才开始计数；`Alpha_Dog_Off` 会停止计数并取消待唤醒。
- `MDCG_ROOT` 可以省略，会落到 `~/.alpha-memory/data/mdcg`。**绝不要填包内路径**（包更新会整个替换包目录）。
- 用户的既有记忆在别处时，把那个绝对路径填进 `MDCG_ROOT` 或 `MDCG_STATE_ROOT`，**不要搬动数据**。
- 要写入必须有 `MDCG_TOKEN`；没有令牌时以只读访客运行。令牌由用户签发，**你不要代替他签发**。

## 4. 验证（只有这一步算数）

重启宿主，然后逐项确认：

1. `tools/list` 能看到 Alpha-Dog 控制面；默认先使用 sidecar 配置。
2. 调 `Alpha_Dog_On`，确认返回 `status=on`（未初始化时应返回结构化初始化请求）。
3. 通过主 MCP 会话发出记忆工具调用，确认 `state/sidecar-counter.json` 计数增长。
4. 到达测试档口后，确认 `state/sidecar-wake-signal.json` 有 `source=sidecar`，并检查 `sidecar-wake-history.jsonl` 的最终状态。
5. 调 `Alpha_Dog_Off`，再发记忆工具调用，确认计数不再增长。
6. 已配令牌时再验证写入返回里的 `committed`；没有令牌时确认写入被明确拒绝。

四项全过才算接通。任何一项没过，回到第 3 步改配置，**不要改内核**。

## 5. 报告什么

- 探测到哪个宿主、实际用的是哪个配置文件（绝对路径）
- 写入的配置块原文
- `datapath.py` 打印的状态根与认知图根
- 第 4 步四项的结果，逐项过 / 不过
- 未解决的：原样贴错误，不要改写成「大致正常」

## 6. 不要做的事

- 不要为了接通而改 `md_cg/` 里的代码——内核与宿主解耦是设计约束，不是待办。
- 不要在配置里写相对路径。
- 不要复制、移动或删除用户的既有记忆目录。
- 不要把令牌写进会被提交的文件里。

## 7. 初始化必读清单

接入完成后，按顺序完成以下 6 项。

### 7.1 接入 Alpha-Dog API 与中间人证书

不接 `Alpha_Dog_On/Off` 也能用（机械降级：cg/stg 可用、计数退回工具调用语义），但**后台不会提醒你**；完整职能（三档自驱唤醒、占位符引擎、结题存档）必须接 API。

接入后必须处理 TLS 中间人，否则模型调用会被杀软 HTTPS 扫描打死（`SELF_SIGNED_CERT_IN_CHAIN`）：

1. 找到杀软/代理根证书，导出为 PEM
2. mcp.json 的 alpha-memory env 加 `NODE_EXTRA_CA_CERTS=<PEM路径>`
3. 重启 MCP

（Alpha-Memory 不代装证书。自检：`Alpha_Dog_On` 返回的 `tlsCheck` 字段会告诉你有没有中间人。）

### 7.2 conversation.dir（自驱唤醒对话源，必填）

`alpha-dog.setting.json` 的 `conversation.dir` 必须显式填写，引擎不静默探测：

```json
"conversation": { "dir": "C:/你的用户名/.pi-agent/agent/sessions/--项目目录编码--" }
```

- 填含 `.jsonl` 的会话目录（引擎递归扫描取 mtime 最新）；**收窄到当前项目目录**，别填 sessions 根（会被其他项目会话抢源）
- **留空的后果**：表面正常，但自驱唤醒永不触发（静默退回工具计数语义）——最容易漏配的一项
- 怎么找：MCP 宿主的 sessions 存储目录，通常在 `~/.<宿主>/agent/sessions/` 下按工作目录编码分文件夹

### 7.3 映射表（看门狗的目标清单）

Alpha-Dog 按注册表 `@memory_mapping_table_md / @memory_mapping_table_json` 读取映射表筛选处理目标。`layer` 字段决定文件进哪个档口：`即时落盘·15轮` / `系统巡检·21轮` / `记忆巡检·30轮`。

最小可用示例（存为 `记忆映射表.json`，在用户的注册表登记后生效）：

```json
{
  "meta": { "version": "v1", "root": "<你的工作区根目录>", "count": 2 },
  "files": [
    { "id": 1, "path": "notes/近期决策.md", "layer": "即时落盘·15轮", "importance": 4, "status": "温", "keywords": ["决策"] },
    { "id": 2, "path": "notes/巡检记录.md", "layer": "系统巡检·21轮", "importance": 3, "status": "温", "keywords": ["巡检"] }
  ]
}
```

配好后确认三档任务（默认说明书 `engine/prompts/alpha-dog-light|medium|heavy.md`，可直接用或替换）：

- **15 轮**：即时落盘（backfill 结题存档 / monitor 继续监听）
- **21 轮**：中档巡检（补齐已成立、可审计的缺口）
- **30 轮**：重档巡检（interrupt / fixed_defer / backfill / monitor 四模式）

并协助用户跑通完整链路：触发 → 唤醒 → 候选 → Alpha 反馈 → 落盘回执。

### 7.4 显式路径依赖（提醒主人处理好）

Alpha-Dog 必然依赖若干显式路径：对话源、映射表、证书、会话根目录。提醒主人把它们放环境变量或在配置里显式声明。

（研发端/使用端可写注册表地址如 `@memory_mapping_table_md`；**发行端不能出现任何机器的绝对路径**——发行端用户自建映射表并在自己的注册表登记。）

### 7.5 cg / stg 接口开关

`alpha-dog.setting.json` 的 `interfaces` 块：

```json
"interfaces": { "Alpha_Dog_On": true, "Alpha_Dog_Off": true, "cg": false, "stg": false }
```

- **cg** = 记忆大脑多态入口（op=write 写 / op=read 读）；**stg** = 语义时空图四操作（纯读）
- **发行版默认 false**（隐藏，只留 On/Off 驾驶舱，走狗的治理链）
- **改 true** = 记忆读写工具直接暴露给 Agent（可绕过狗直读写，调试用）；改完重启 MCP
- 修改位置：`interfaces.cg / interfaces.stg`
