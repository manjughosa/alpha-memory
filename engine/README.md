# Alpha-Memory

Alpha-Memory 是面向 AI Agent 的本地长期记忆系统。它把对话沉淀为可审阅的 Markdown 认知图，通过标准 MCP 接口提供写入、检索、关系、时间线、验证和治理能力。

项目包含两个核心部分：

- **Alpha-Memory**：长期记忆内核，记忆本体是 Markdown，索引可重建。
- **Alpha-Dog**：增量维护调度器，默认只暴露 `Alpha_Dog_On` 和 `Alpha_Dog_Off`。

> 🧭 **想知道内部怎么分模块**：见 [`md_cg/README.md`](md_cg/README.md)——记忆内核的模块地图与数据流。

> 🤖 **自动事件源**：推荐挂载 `runtime/alpha-dog-sidecar.cjs`。它包裹项目 bridge，在 Node 侧计数并调用 Alpha-Dog runtime；Agent 不需要自己提醒，主 MCP 流量仍经过凭据、策略和一致性闸门。

## 鸣谢

运行时依赖：标准 MCP stdio 通道、随包的 Python 内核和 Node.js runtime。Alpha-Memory 推荐事件源由随包 sidecar 在 MCP stdio 接缝提供，宿主不需要主动提醒。需要严格的真实对话轮语义时，宿主仍可投递标准化事件；sidecar 的工具调用计数只是无宿主依赖的 fallback。

以下项目提供了**设计参照**：

- **Omega-Memory**（Apache-2.0）：在"分层降级、熔断、校验、评估"这一问题域上提供了成熟的工程参照。Alpha-Dog 的降级与熔断是就着其**提问方式**、针对自身运行链重新设计的实现。([omega-memory](https://github.com/omega-memory/omega-memory))
- **MCP Memory**（`@modelcontextprotocol/server-memory`，MIT）：其公开契约简洁，本项目对照了它的原子化纪律与关系类型受控理念，并在其之上引入了关系类型约束、修订语义与本地治理接口。([memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory))
- **dsh-memory**：感谢其公开的工程思路，dsh-memory是一个跨 harness 的记忆基础设施，其“大脑”本身就是一个标准的 stdio MCP server，可以被任何支持 MCP 的 AI Agent 直接接入，不与特定框架绑定。([dsh-memory](https://github.com/FuRongJun-1999/dsh-memory))

## Alpha-Dog 部署与发行安全

Alpha-Dog 是 MCP 内核提供的 API、智能体运行时和状态驾驶舱，不是插件。MCP 发行物不得携带或恢复 DSH 插件入口；自动事件源由随包 sidecar 提供，sidecar 包裹现有 bridge，不绕过 Python 安全边界，也不修改宿主插件配置。sidecar 事件默认按 MCP 工具调用计数，不冒充真实用户对话轮；需要真实轮语义时仍使用宿主 adapter 投递标准化事件。

研发端按 `legacy -> shadow -> alpha_dog` 逐步推进。`shadow` 会让旧链和 Alpha-Dog 并行运行，但 `formalWrites=false`，只生成报告和差异；至少三轮真实双链对账通过后才允许 promotion。发行包默认保持 `enabled=false`、`initialization.status=unconfigured`、`state.mode=legacy`，不携带研发部署态、运行状态或真实凭据。

安装后可运行只读自检：

```bash
npm run doctor
```

`apiKeyRef` 必须是宿主密钥存储或环境变量的引用名，不能写入明文 API key。第 30 轮由于 15 是 30 的约数，可能同时触发 light 与 heavy；这符合多档口 wake plan 规则，具体顺序由 `schedule.simultaneousOrder` 控制。

## 特性

- 本地优先：记忆本体保存在用户指定的用户级目录，不写入安装包。
- 可审计：原文即真源，写入、验证、保护和遗忘均有明确结果。
- 可复现：确定性规则负责检索、路由和写入裁决。
- MCP 标准接口：任何支持 stdio MCP 的工程端都能直接接，内核不含任何宿主专属代码。
- 故障降级：模型或桥接不可用时进入机械模式，任务挂账，不静默丢失。
- 熔断恢复：连续失败触发冷却，注册表损坏时回退最后有效快照。
- 可影子验证：`shadow` 模式让新链并行跑、只出报告不写正式记忆，连续一致后才提权切换。

## 要求

- **Python 3** —— 记忆内核，接 MCP 只需要它
- **Node.js `>=22.19`** —— 运行 Alpha-Dog runtime、doctor 和随包测试时需要；MCP Python 内核仍可独立运行

## 安装

内核是一个标准 stdio MCP server，**宿主无关**：不依赖任何平台 SDK，不需要改宿主源码。

**只要内核**：不需要 `npm install`。仓库里已经带了可直接运行的 `md_cg/`，
只要 Python 能找到它（见下面的 `PYTHONPATH`），在 `engine/` 下就能起：

```bash
cd engine
python -m md_cg.mcp_server
```

**要使用 Alpha-Dog runtime 或跑测试**：仓库带了 `lib/` 构建产物，但仍建议装一次开发依赖重建：

```bash
cd engine
npm install --include=dev
npm run build
npm test
```

把下面这段加进你的 MCP 客户端配置（字段名按宿主要求调整）。推荐用 sidecar；它会包裹现有 bridge，不要直接替换成裸 Python：

```json
{
  "mcpServers": {
    "alpha-memory": {
      "command": "node",
      "args": ["<Alpha-Memory>/engine/runtime/alpha-dog-sidecar.cjs"],
      "env": {
        "ALPHA_MEMORY_HOME": "<Alpha-Memory>",
        "SIDECAR_MODE": "wake",
        "SIDECAR_NETWORK": "off"
      }
    }
  }
}
```

sidecar 会透传 MCP 输入输出，并启动项目 bridge；bridge 再负责 Python 路径、令牌、策略和一致性闸。`ALPHA_MEMORY_HOME` 应指向包含 `alpha_memory_bridge.js` 与 `engine/` 的项目根。Linux / macOS 只需保证 `node` 和 Python runtime 可用。

**MCP 入口由 setting 决定，不用手抄路径**：改完 `alpha-dog.setting.json` 的 `sidecar` 块（`entry` / `bridge` / `node` / `serverName` / `mode` / `network` / `countScope`），执行

```bash
cd engine
npm run mcp:config
```

即可打印出可直接粘进宿主的 `mcpServers` 块。该命令只读配置，不启动 bridge、不写状态、不起任何服务。

sidecar 默认 `SIDECAR_NETWORK=off`，只在本地调用 Alpha-Dog runtime；`SIDECAR_MODE=observe` 只记录不唤醒，`wake` 才执行 runtime 唤醒。`state.mode=legacy` 或 Alpha-Dog 未通过 `Alpha_Dog_On` 时，sidecar 不计数。

`MDCG_ROOT` **可以不配**：不配时记忆落到 `~/.alpha-memory/data/mdcg`（见下一节）。

宿主需要把环境信息（会话日志在哪、模型目标是什么）**配进来**，内核自身不带任何平台假设。

## 记忆写在哪里

记忆写入位置与安装包目录、进程 cwd 都解耦，因此更新包不会删除记忆。解析优先级由高到低：

1. 环境变量 `MDCG_DATA_ROOT`（数据根）/ `MDCG_ROOT`（认知图根）
2. `<用户级状态根>/paths.json` 的 `"data_root"` / `"root"`
3. 用户级状态根下的 `data/mdcg`
4. 默认：`~/.alpha-memory/data/mdcg`

用户级状态根本身按 `MDCG_STATE_ROOT` → `ALPHA_MEMORY_HOME` → `~/.alpha-memory` 依次决定，
**不含任何宿主目录约定**。

查看当前实际解析结果：

```bash
cd engine
python md_cg/datapath.py
```

改到别处：

```bash
python md_cg/datapath.py --set-root /绝对路径/mdcg
```

**不要把 `mdcg.root` 设成相对路径**（如 `data/mdcg`）：包更新会整目录替换，记忆会随之消失，而且读写两侧的解析基准可能不同，导致「写进去读不出来」。

### 备份

记忆本体是纯 Markdown 文件，**直接复制目录即可完成备份**：

```bash
# 先确认根的实际位置
python md_cg/datapath.py
# 整目录复制（示例：默认位置）
cp -r ~/.alpha-memory/data/mdcg /备份位置/mdcg-$(date +%Y%m%d)
```

Windows 上用 `robocopy` 或资源管理器复制即可。备份前建议停止正在写入的宿主进程，避免复制到写入中途的状态。
迁移工具（`python -m md_cg.migrate --help`）用于格式迁移，**不替代备份**。

### 仓库里为什么没有 `data/` 和 `token/`

下载这个仓库后你会发现根目录下既没有 `data/` 也没有 `token/`。
因为记忆和凭据都**默认落在你的用户目录**，不落在仓库里：

| 东西 | 默认位置 | 说明 |
|---|---|---|
| 记忆本体 | `~/.alpha-memory/data/mdcg` | 纯 Markdown，你的全部记忆 |
| 凭据（写入令牌） | `~/.mdcg/` | 不配就是只读访客 |

这样做有三个好处：更新仓库不会删掉你的记忆；把仓库传给别人不会带走你的记忆；`git status` 永远是干净的。

想改到别处（比如放进仓库跟代码一起备份），用环境变量或路径配置指过去：

```bash
export MDCG_ROOT=/你想放的地方/mdcg        # 只改记忆本体
export MDCG_STATE_ROOT=/你想放的地方       # 一次改掉整个用户级状态根
```

但要注意：`.gitignore` 已经把 `data/`、`token/`、`*.token` 全部排除，
**即使你把记忆放进仓库目录，它们也不会被提交**——这是有意为之，记忆和凭据不该进版本库。

## 写入权限与令牌

`md_cg` 是 **fail-closed**：不配令牌时以**只读访客（guest）**运行——读取、召回、时间线可用，
但写入不落盘，且写操作会返回明确的权限错误。推荐先签发最小权限令牌：

```bash
cd engine
python -m md_cg.tokens issue --role recorder --actor alpha-memory \
  --clearance internal \
  --ops-allow info,route,read,write,recent \
  --layers-allow knowledge,contextual,structural,goals,unresolved,rejected
```

把签发的令牌通过环境变量传给宿主与子进程——就是上面 MCP 配置里那份 `env`：

```json
{
  "env": {
    "MDCG_TOKEN": "<签发的令牌>"
  }
}
```

令牌是**凭据**：写进配置文件时请自行确认文件权限；也可以由宿主从密钥环读出后注入进程环境，
避免明文落在配置里。

取值说明（自查命令：`python -m md_cg.tokens roles` 打印角色职责矩阵）：

| 参数 | 取值 | 说明 |
|---|---|---|
| `--role` | `guest` `output` `recorder` `verifier` `reflection` `sustain` `designer` | 权限从窄到宽；只有 `designer` 具备管理权（`can_admin`） |
| `--clearance` | `public` `internal` `private` `secret` | 可读写的密级上限 |
| `--ops-allow` | `help` `info` `route` `read` `write` `goal` `task` `recent` `verify` `review` `forget` `protect` `identity` `consistency` `metacognition` `self_state` `evolution` `sustain` `scrub` `predict` `causal` `whitebox` `index_code` `index_doc` `ref` `theory` `link` `session` `ingest` `export` `maintain` `consolidate` `insight` `ccg` `status` | 允许的 op 全集 |
| `--layers-allow` | `anchor` `structural` `knowledge` `contextual` `self` `rejected` `unresolved` `goals` | 8 个记忆层；`anchor` 与 `self` 属保护层，通常不开放给自动写入 |

令牌管理与排障：

```bash
python -m md_cg.tokens list      # 列出令牌（不含密钥材料）
python -m md_cg.tokens verify    # 校验令牌并打印身份
python -m md_cg.tokens revoke --token-id <id>   # 吊销
```

> **吊销后请一并清理本机密钥环文件**（`~/.mdcg/token` 与 `~/.mdcg/_tokens.json` 中对应记录）。
> 两者不一致时子进程会启动失败，表现为"工具全都不见了"。

## 写入契约：怎么算真正写进去

写入返回 **`ok: true` 不等于已落盘**。判断依据只有一个字段：`committed`。

| 返回 | 含义 | 内容在哪 |
|---|---|---|
| `committed: true` | 已落盘 | 记忆目录下对应层的 Markdown 文件 |
| `committed: false`, `moved_to: "review_queue"` | 进了审核队列，**未落盘** | `hippocampus/inbox.jsonl` |
| 返回权限错误 | 令牌不足 | 未写入 |

进入审核队列的常见原因是**写入判定为 `DEFER`**：例如未配置合规/纪律规则
（`MDCG_POLICY_FILE`）时，判定器无法裁决，会保守地转入队列等待人工放行，而不是直接落盘。

放行队列中的条目：

```javascript
// 列出待裁决条目（不带 decision 时 op=review 默认即为列表）
cg({ op: "review" })                     // → { "pending": [ ... ] }

// 裁决放行（accept 后落盘）
cg({ op: "review", pid: "<条目 id>", decision: "accept" })
```

也可用命令行工具（子命令为 `accept` / `reject` / `edit` / `merge` / `noop`）：

```bash
cd engine
python scripts/review_cli.py accept <条目 id>
python scripts/review_cli.py --help      # 查看全部参数
```

确认落盘的可靠方式：读取返回的 `node_id` 是否可再次读出。

```javascript
cg({ op: "read", node_id: "mem_..." })
cg({ op: "info" })        // 节点总数等概览
```

写入时的两条纪律（来自官方 MCP Memory 的既有共识）：

- **原子化**：一个节点只装一个可判真假的事实，不要把多件事写进同一条。
- **受控词表**：关系类型必须可枚举，不允许自由文本。

## 工具面

| 配置 | 暴露内容 | 数量 |
|---|---|---|
| `tools: core`（默认） | `cg` / `stg` 两个认知基元 | 2 |
| 进程侧 `MDCG_MCP_SURFACE=kernel`（默认） | 同上 | 2 |
| 进程侧 `MDCG_MCP_SURFACE=full` | 2 基元 + `mdcg_*` 细粒度 | 33 |
| `tools: brain` | 完整认知面（排除管理类） | 30 |
| `tools: all` | 服务端工具，仍应用宿主风险工具拒绝表 | 依拒绝表 |
| `tools: [name, ...]` | 显式选择；扩权责任由配置者承担 | — |

日常使用只需 `cg` / `stg`：`cg` 已覆盖 `route` / `read` / `write` 等全部 op。

### 两个接入面不要混

上表的 `tools` 只决定**记忆内核**暴露什么；`Alpha_Dog_On` / `Alpha_Dog_Off` 属于
**Alpha-Dog 控制面**，由 MCP 桥注册，不受 `tools` 选择影响。

| 面 | 接口 | 谁来调 |
|---|---|---|
| Alpha-Dog 控制面 | `Alpha_Dog_On` / `Alpha_Dog_Off` | 人 / 宿主，控制看门狗电源 |
| 记忆内核直连面 | `cg` / `stg`（`MDCG_MCP_SURFACE=full` 时另有 `mdcg_*`） | Agent，读写记忆 |

内部运行层——机械降级、熔断、挂账队列、注册表、批次、反馈、审计——**不注册成对外工具**，
因此不存在"第四、第五个接口"。它们只在状态里可见（见下文「机械降级运行层」）。

## Alpha-Dog

Alpha-Dog 默认关闭。配置文件为包内 `alpha-dog.setting.json`，也可用
`alphaDog.settingPath` 指向别处。

控制工具：

- `Alpha_Dog_On`：开始计数，**不立即唤醒**。
- `Alpha_Dog_Off`：停止调度，并使正在执行的结果失效。

### Setting 参数说明

`alpha-dog.setting.json` 里几个最容易读错的参数：

| 参数 | 含义 | 它**不是** |
|---|---|---|
| `interfaces.Alpha_Dog_On` | 是否把 `Alpha_Dog_On` 这个工具**暴露**给 MCP 客户端 | 不是“狗开着” |
| `interfaces.Alpha_Dog_Off` | 是否把 `Alpha_Dog_Off` 这个工具**暴露**给 MCP 客户端 | 不是“让狗睡觉” |
| `interfaces.cg` / `interfaces.stg` | 是否暴露记忆内核直连面（调试用，默认关） | — |
| `enabled` | 声明“期望启用”；当前由 `doctor` 作为安全默认判据 | 不是电源开关 |
| `initialization.status` | `unconfigured` / `configured` / `declined` | — |
| `state.mode` | 谁在执行：`legacy` / `shadow` / `alpha_dog` | 不控制睡醒 |

两个硬事实：

- **`interfaces` 只管“按钮露不露”，不管“狗睡不睡”。** 狗当前是睡是醒看运行态 `running` 与 `watchdog`（`engine/state/mcp-control.json` 或 `state/runtime.json`），由调用 `Alpha_Dog_On` / `Alpha_Dog_Off` 决定。
- **`interfaces.Alpha_Dog_On` 与 `Alpha_Dog_Off` 必须都为 `true`。** 任一为 `false` 会让整份设置校验失败，加载器回落默认值（`enabled=false`、`unconfigured`、`legacy`）——表现为“怎么配都没生效”。

睡与醒：

```text
常态休眠（默认）   → 上电后看门狗即休眠；只在第 15/21/30 轮被叫醒一次，跑完一个批次立刻回去睡
上电待命           → 调 Alpha_Dog_On（返回值里 watchdog 仍是 dormant，不立即唤醒）
彻底断电           → 调 Alpha_Dog_Off（停止计数/调度、取消未执行唤醒、作废在途结果、存盘，不追补轮次）
重启后也不自动上电 → enabled=false
```

要使用严格的用户回合语义，客户端 Agent 向同一 MCP stdio 连接发送 JSON-RPC notification `alpha-dog/round_tick`，参数为 `{eventId, sessionId, round, userInput, timestamp}`。它是内部事件契约，不注册为外部 tool；不需要安装插件或修改宿主 hooks。不提供该事件时，sidecar 可按 MCP 工具调用次数降级计数，但不会把它冒充成用户回合。

档口与唤醒周期：**档口 = 每 N 条用户消息唤醒一次**（计数由会话的 `user/message` 事件驱动，
实现为 `round % slot === 0`）。

| 档口 | 含义 |
|---|---|
| 15 | 每 15 条用户消息 |
| 21 | 每 21 条用户消息 |
| 30 | 每 30 条用户消息 |

默认唤醒顺序 `21 → 15 → 30`：同一轮若有多个档口同时到期，按此顺序执行。

四个动作的语义：

| 动作 | 含义 | 是否调用模型 |
|---|---|---|
| `backfill` | 回填：把最近未归档的事实补进记忆 | 是 |
| `monitor` | 巡检：检查一致性、悬空引用与陈旧条目 | 是 |
| `interrupt` | 打断：在轮次中途插入一次维护 | 是 |
| `fixed_defer` | 固定推迟：本次到期不执行，顺延到下一轮 | 否 |

`15` / `21` 档口只开放 `backfill` / `monitor`；`30` 档口开放全部四个。
说明书也按档口隔离：15/21 的提示词里**看不到** `interrupt` 和 `fixed_defer`。

### 运行模式：legacy / shadow / alpha_dog

切换正式链**不会一步切断旧链**。模式在 `alpha-dog.setting.json` 的 `state.mode` 里：

| 模式 | 旧链 | Alpha-Dog | 正式写入 |
|---|---|---|---|
| `legacy` | 运行 | 不运行 | 旧链负责 |
| `shadow` | 运行 | 运行，读同一份输入 | **关闭**，只产出报告和差异 |
| `alpha_dog` | 保留可回退 | 正式执行链 | 开启 |

切换纪律：

1. 先跑 `shadow`：新链读同样的输入，只写临时状态和审计路径，不碰正式记忆。
2. 逐轮比较两边的**轮次、候选、档口、反馈**，差异记入影子审计。
3. 至少连续三轮比较**完全一致**才允许提权；任一轮不一致则门禁不放行。
4. 通过后才切 `alpha_dog`；旧链不立即删除，保持可回退。

门禁不是提示词里的君子协定，是代码里的硬条件（`canPromote`）。未通过时
`promoteMode` 拒绝改配置，Alpha-Dog 也不可能自己给自己提权。

故障治理参数：

```json
{
  "governance": {
    "failureThreshold": 3,
    "cooldownMs": 300000,
    "maxPending": 100
  }
}
```

模型未配置、调用失败或熔断打开时，调度器进入 `mechanical`（机械）模式：不调用模型，
把待办记入挂账队列，调度本身继续运转。状态含义：

| 状态 | 含义 |
|---|---|
| `ok` | 调用成功 |
| `not-configured` | 拿不到可用的 provider + model |
| `model-disabled` | 模型能力被显式关闭 |
| `degraded` | 已降级并挂账（含熔断打开、调用异常） |
| `error` | 模型返回失败 |
| `invalidated` | 执行期间被 `Alpha_Dog_Off` 作废 |

模型目标取自宿主本轮路由（provider 与 model **必须成对**）。也可在 `alpha-dog.setting.json`
里显式指定 `model.provider` 与 `model.name`，显式配置优先。

### 机械降级运行层

这是 Alpha-Dog 最容易被误读的一部分：**它不是第三个接口，是模型不可用时的运行态。**

一句话：**降级不等于停摆。** 模型、桥或注册表挂了，Alpha-Dog 仍然计数、建唤醒计划、
按注册表筛目标、分批、把没做完的事挂账、保存状态——只是不调用模型、不假装处理成功。

生命周期：

```text
正常运行
  → 模型不可用（未配置 / 调用失败 / 挂账超限）
  → mechanical（机械模式）：零模型调用，任务进挂账队列，调度继续转
  → 连续失败达 failureThreshold
  → 熔断打开（circuit: open）：冷却期内直接挂账，不再尝试
  → 冷却结束
  → half-open：允许一次试探调用
  → 成功 → 恢复 closed；失败 → 重新打开
```

`Alpha_Dog_Off` 的语义是**断电**，不只是关模型：停止计数、停止调度、取消未执行唤醒、
使正在执行的结果失效（`invalidated`，不提交），并保存可恢复状态。关闭期间不追补轮次。

治理分层与落点：

| 层 | 内容 | 当前落点 |
|---|---|---|
| P0 | 降级、熔断、失败挂账、注册表快照回退、`Off` 结果作废 | `src/alpha-dog-governance.ts`、`src/alpha-dog.ts` |
| P1 | 原子实体、受控关系类型、资源更新通知、结构化写入回执 | `src/memory-contract.ts`、`src/alpha-dog/feedback.ts` |
| P2 | 状态持久化、挂账队列、批次账本、验收铁闸 | `src/alpha-dog/runtime/state.ts`、`wake-queue.ts`、`batcher.ts` |
| P3 | 15/21/30 档口、连续唤醒、watchdog 说明书、shadow/正式切换 | `src/alpha-dog.ts`、`prompts/`、`src/alpha-dog/modes.ts` |

P0 的"降级链"是就着 Omega 的**提问方式**（这一层挂了服务还能不能继续）针对自身运行链
重新实现的，没有把它的五层架构和依赖搬进来；P1 借的是官方 MCP Memory 的**纪律**
（一个节点一个事实、关系类型受控），不是它的能力上限。

写入仍然 fail-closed：`ok: true` 不算写成功，必须同时拿到 `committed: true`、
非空 `nodeIds` 和审计回执，三者缺一即判失败并计入失败批次——降级状态下尤其如此。

**尚未收口的治理项**（不当已完成）：模型调用次数/耗时/成本的完整统计、
官方 Memory 风格的完整资源通知链、以及 P0/P1 的评估报告面。这三项属于后续阶段，
不在当前主链内。

## 调度目标从哪来

Alpha-Dog **不读全部记忆文件**。它只读注册表，再按当前档口筛选、分批。

注册表在 `alpha-dog.setting.json` 的 `registry` 两项里指定（写 `@别名` 时由
`agent_registry.json` 解析为真实路径）：

```json
"registry": {
  "memoryMappingTableMd": "@memory_mapping_table_md",
  "memoryMappingTableJson": "@memory_mapping_table_json"
}
```

按档口筛选（各档口的 `registryTags` 决定它看哪些条目）：

| 档口 | 筛选标签 |
|---|---|
| 15 | `即时落盘·15轮` |
| 21 | `系统巡检·21轮` |
| 30 | `记忆巡检·30轮` |

然后按优先级和 token 预算分批（批量大小取 `batchSize`，默认 8）。每个批次都会落盘：

```json
{
  "batchId": "medium-210-01",
  "slot": "medium",
  "fileIds": ["..."],
  "status": "completed",
  "processed": 18,
  "failed": 0,
  "nextBatch": "medium-210-02"
}
```

- 路径必须是**根目录内的相对路径**：绝对路径与越出根目录的 `../` 一律拒绝（fail-closed）。
- 仓库里**不带这两份清单**，也不预设内容——不写就什么都不维护，调度不报错、不编造目标。
- `json` 清单的格式：`{"files": [{"id", "path", "layer", "importance", "status"}]}`。
- 读不到注册表时**回退上一份有效快照**（`mappingError` 会如实暴露），不静默清空目标。
- 失败批次单独记账（`status: "failed"` + `failed` 计数），可独立恢复，不重跑已完成批次。
- 兼容写法：旧的 `targets: { "json": ..., "md": ... }` 仍被接受，加载时会归一为新结构。

## MCP 直连

实机验证：不配 `MDCG_ROOT` 也能起，根自动落到 `~/.alpha-memory/data/mdcg`。
在包根（`engine/`）执行：

```bash
cd engine
MDCG_ROOT=<记忆目录路径> python -m md_cg.mcp_server
```

Windows PowerShell：

```powershell
cd engine
$env:MDCG_ROOT = "<记忆目录路径>"
python -m md_cg.mcp_server
```

常用环境变量：

| 变量 | 必填 | 作用 |
|---|---|---|
| `MDCG_ROOT` | 否 | 认知图根目录；不配则用用户级默认 `~/.alpha-memory/data/mdcg` |
| `MDCG_DATA_ROOT` | 否 | 数据根（`MDCG_ROOT` 的上一级） |
| `MDCG_ACTOR` | 否 | 调用方标识，私有内容按 `(tenant, actor)` 派生密钥 |
| `MDCG_TENANT` | 否 | 租户，默认 `default` |
| `MDCG_TOKEN` | 否 | 写入令牌；不配则只读 guest |
| `MDCG_MCP_SURFACE` | 否 | `kernel`（默认，2 工具）/ `full`（33 工具） |
| `MDCG_POLICY_FILE` | 否 | 合规/纪律规则库；不配时写入判定多为 `DEFER` |

## 多宿主接入

内核与宿主之间只有一层关系：宿主用 stdio 起 `python -m md_cg.mcp_server`，然后调用 MCP 工具。
上面「安装」一节给的就是完整配置——**没有任何宿主专属步骤，包里也没有任何宿主专属目录**。

平台相关的信息（会话日志在哪、模型目标是什么）一律由宿主在配置时经环境变量**注入**，
内核不预设、不硬编码任何宿主目录。

**不想手工配**：把 [`AGENT-SETUP.md`](AGENT-SETUP.md) 丢给你的 Agent——它自己探测宿主、
写配置、跑验证，四项验证全过才算接通。

## 术语表

| 术语 | 含义 |
|---|---|
| `md_cg` | 记忆内核包名，读作「md 认知图」；`md` = Markdown（原文即真源），`cg` = 认知图 |
| `CG` | 认知图（cognitive graph）：节点 + 边的记忆网络，即 `md_cg` 的主体 |
| `STG` | 时空图入口：关系、时间线、锚点与一致性查询 |
| `CCG` | 六要素条件模板（功能名 / 生效条件 / 子功能 / 执行 / 验证方式 / 不适用条件），写入合格记忆的结构要求 |
| 记忆层 | 8 个层：`anchor`（锚点，保护层）、`structural`（结构）、`knowledge`（知识，主检索层）、`contextual`（情景）、`self`（自我，保护层）、`rejected`（负记忆）、`unresolved`（未决）、`goals`（目标） |
| 写入判定 | 每次写入由确定性规则裁决，结果为 `ACCEPT`（落盘）/ `REJECT`（拒绝）/ `DEFER`（转审核队列）/ `BLINDSPOT`（信息不足，不冒充接受） |
| 机械模式 | 模型不可用时 Alpha-Dog 的降级态：只挂账不调用模型 |
| 熔断 | 连续失败达阈值后进入冷却，冷却期内不再尝试调用，避免反复烧接口 |
| 挂账 | 把未能执行的任务记入待处理队列，不静默丢弃 |
| 档口 | Alpha-Dog 的唤醒周期，单位是**用户消息条数**（15 / 21 / 30） |
| 注册表 | Alpha-Dog 的目标清单来源，决定它看哪些文件；不读全部记忆 |
| 批次 | 按优先级和预算切分的目标分组，逐批处理并单独记账 |
| 回执 | 写入的结构化凭证：`committed` + 节点 id + 审计记录，缺一不算成功 |
| 影子模式 | `shadow`：新链并行运行但不正式写入，只产出报告和差异 |
| 认知图根 | 记忆本体所在目录，见「记忆写在哪里」 |

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 安装后没有工具 | Python 不可用或工具面配置不对 | `cd engine && python -m md_cg.mcp_server` 手动验证；检查 `tools` 配置 |
| 能读取但写不进去 | 无令牌或权限不足 | 见「写入权限与令牌」，确认 `--role` / `--ops-allow` / `--layers-allow` |
| 返回 `ok: true` 但读不到 | 进了审核队列未落盘 | 看 `committed` 与 `moved_to`，见「写入契约」 |
| 记忆写入后找不到文件 | 写入到了另一个根 | `python md_cg/datapath.py` 查看实际解析结果 |
| 更新后数据消失 | `mdcg.root` 用了相对路径或落在包目录内 | 改为用户级目录或绝对路径 |
| Alpha-Dog 只挂账 | 宿主未提供可用模型目标 | 检查宿主 model 配置，或在 setting 里显式指定 `model.provider` / `model.name` |
| 目标列表为空 | 没在 `alpha-dog.setting.json` 的 `targets` 里指定清单文件，或文件不存在 | 见「调度目标从哪来」 |
| 改完 `alpha-dog.setting.json` 什么都不生效 | 配置文件被写坏或校验失败 | 检查 JSON 语法与必填项（`Alpha_Dog_On` / `Alpha_Dog_Off` 必须都为 `true`）；加载失败会回落到默认配置并在状态里给出 `loadError` |

## 开发与验证

```bash
cd engine
npm run build
npm test
npm run test:python
npm pack --dry-run --json
```

发布前必须满足：

- TypeScript 构建通过。
- Node 测试全部通过。
- Python 测试全部通过（无对应数据面的用例会显式 SKIP，不虚报通过）。
- npm 包不含真实记忆、凭据、运行时、索引缓存和备份。
- Git 工作树中不出现本机绝对路径或个人身份信息。

## 数据边界

以下内容不应提交或发布：

- `data/`、`token/`
- `runtime/`、`.runtime/`
- `backups/`
- `engine/_md_cg_p*/`（记忆索引缓存）
- `node_modules/`、`__pycache__/`、`*.pyc`
- 真实用户记忆、真实凭据与本机路径

## 许可证

本项目采用 MIT 许可，见 [LICENSE](LICENSE)。第三方名称仅用于来源标注，不作为本项目名称、
接口名称或产品身份。
