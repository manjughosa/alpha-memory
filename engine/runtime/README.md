# Alpha-Dog Sidecar · MCP stdio 事件源

`alpha-dog-sidecar.cjs` 是 Alpha-Dog 的**默认事件源**。它挂在 MCP 配置的 `command` 位置上，
包裹现有 `alpha_memory_bridge.js`，在 Node 侧完成计数与唤醒。

**它取代了「让 Agent 自己记得提醒」的做法**：Agent 不需要在对话里主动调任何东西，
也不需要宿主插件。挂上 sidecar 之后，档口到点由 sidecar 自己触发。

## 它做什么，不做什么

| 做 | 不做 |
|---|---|
| 字节级透传 MCP stdio（不改写、不缓存响应体） | 不解析响应内容 |
| 统计记忆工具调用，按档口触发唤醒 | 不冒充真实用户对话轮 |
| 在进程内调用 Alpha-Dog runtime | 不把 tick 发给 Python 内核 |
| 尊重 `Alpha_Dog_On/Off` 与 `state.mode` | 不在 `legacy` 或断电时计数 |
| 失败可见（stderr + `sidecar.log`） | 不用空 catch 静默吞错 |

## 挂载

MCP 配置里把 `command` 指向 sidecar，而不是裸 Python：

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

`ALPHA_MEMORY_HOME` 指向包含根目录 `alpha_memory_bridge.js` 与 `engine/` 的绝对路径。
sidecar 会把 `PYTHONPATH` / `MDCG_ROOT` / `MDCG_TOKEN` 等原有 env 原样交给 bridge。

**不要把 `command` 改成裸 `python -m md_cg.mcp_server`。** 那会绕过 bridge，
同时丢掉令牌注入、策略文件、工具副作用三分类和咽喉闸。

## 为什么它包 bridge 而不是包 Python

`alpha_memory_bridge.js` 是安全边界，不是可选装饰：

- 工具副作用**显式三分类**（`WRITE_GOVERNED` / `WRITE_SPECIAL` / `READ_ONLY`），未登记的工具有 fail-closed 拒绝；
- `sanitizeToolCall` + 咽喉闸 `consistencyGateWithSemantic`；
- `MDCG_TOKEN` / `MDCG_POLICY_FILE` 注入；
- `MDCG_ROOT` 的「验了再信」（`_index.json` 存在且不在备份区）——防止陈旧 env 根把引擎引到空库形成平行数据。

sidecar 直接 spawn Python 会把这些一起丢掉，症状是「装好了但记忆永远是空的」，且不报错。

## 控制面：谁说了算

控制状态由 **bridge** 写入 `engine/state/mcp-control.json`，sidecar 只读，不双写。

- `Alpha_Dog_On` → 上电，看门狗保持休眠，**不立即唤醒**
- `Alpha_Dog_Off` → 停止计数、取消待唤醒、runtime 断电；关闭期间**不追补轮次**
- `state.mode = legacy` → sidecar 完全不计数
- `sidecar.enabled = false` → 不计数（`SIDECAR_FORCE=1` 仅供诊断）

## 配置

MCP 入口由 `alpha-dog.setting.json` 的 `sidecar` 块决定，**不在宿主配置里写死路径**：

```json
"sidecar": {
  "enabled": true,
  "mode": "wake",
  "network": "off",
  "countScope": "tool_call",
  "entry": "engine/runtime/alpha-dog-sidecar.cjs",
  "bridge": "alpha_memory_bridge.js",
  "node": "",
  "serverName": "alpha-memory"
}
```

| 字段 | 含义 |
|---|---|
| `enabled` | 是否允许计数（`false` 时完全不计数；`SIDECAR_FORCE=1` 仅供诊断） |
| `mode` | `observe` / `signal` / `wake` |
| `network` | 出网闸，默认 `off` |
| `countScope` | `tool_call`（只数 `cg`/`stg`）或 `all_tools` |
| `entry` | **sidecar 自身路径**，相对项目根或绝对路径 |
| `bridge` | 被包裹的 bridge，相对项目根或绝对路径 |
| `node` | 可选 node 可执行文件；留空用当前 node |
| `serverName` | 渲染 mcpServers 时用的键名 |

### 直接生成粘贴用的 MCP 配置

改完 setting 后，不用手抄路径：

```bash
cd engine
npm run mcp:config
```

它把 `sidecar` 块渲染成可直接粘进宿主的 `mcpServers` 块（绝对路径已解析），
并且**只读配置**：不启动 bridge、不写状态、不起任何服务。
实现只有 sidecar 的 `--print-config` 一处，脚本只做转发，避免两份逻辑漂移。

> 这仍然只是 **MCP stdio**：换 `command`、换 `args`、换 `env`，都在宿主既有的 MCP 配置面上完成。
> sidecar 不监听任何端口、不注册任何工具、不写宿主配置、不含 hooks 或安装器。

环境变量覆盖同名配置：

| 变量 | 取值 | 说明 |
|---|---|---|
| `SIDECAR_MODE` | `observe` \| `signal` \| `wake` | `observe`：只计数、只写信号；`wake`：到档口调用 runtime |
| `SIDECAR_NETWORK` | `on` \| `off` | 默认 `off`。网络闸，见下 |
| `SIDECAR_TICK_SCOPE` | `tool_call` \| `all_tools` | `tool_call` 只数 `cg`/`stg`；`all_tools` 连 `mdcg_*` 写工具一起数 |
| `ALPHA_MEMORY_HOME` | 绝对路径 | 项目根 |
| `ALPHA_MEMORY_BRIDGE` | 绝对路径 | 覆盖 `sidecar.bridge` |
| `ALPHA_DOG_SETTING` | 绝对路径 | 覆盖 setting 位置 |
| `SIDECAR_NODE` | 绝对路径 | 覆盖 `sidecar.node` |
| `STATE_DIR` | 绝对路径 | 状态目录覆盖 |
| `SIDECAR_FORCE` | `1` | 忽略 `sidecar.enabled=false`，仅供诊断 |

### 网络闸

`SIDECAR_NETWORK=off`（默认）时，sidecar **不产生任何网络出口**：
它不 spawn 联网子会话，只在本地调用 runtime；模型未接时 runtime 走 governance 的
机械降级并把唤醒挂账，**不伪造成功**。信号里会带 `network: disabled`。

要真正让看门狗调模型，需要在 Setting 中配置兼容 OpenAI completions 的模型地址/模型 ID/`apiKeyRef`，让对应环境变量存在，并显式把 `SIDECAR_NETWORK` 设为 `on`。实现使用 Node 原生 `fetch`，不依赖宿主模型插件。

## 档口与语义

档口从 `schedule.slots` 读取，默认 `light@15` / `medium@21` / `heavy@30`，
同轮多档口按 `schedule.simultaneousOrder` 顺序触发（互不共享模型上下文，只共享结构化状态）。

**计数语义要如实理解**：`countScope=tool_call` 数的是**记忆工具调用次数**，不是对话轮数。

- 一个回合里 Agent 调 3 次 `cg` → 计数 +3
- 一个回合一次不调 → 计数 +0

所以它比真实对话轮跑得快，`userInput` 也拿不到（MCP 接缝只看得到工具参数）。
需要严格的真实轮语义时，客户端 Agent 向同一 stdio 连接发送内部 JSON-RPC notification：

```json
{"jsonrpc":"2.0","method":"alpha-dog/round_tick","params":{"eventId":"session-1:42","sessionId":"session-1","round":42,"userInput":"本轮用户输入","timestamp":"2026-..."}}
```

该 notification 不注册成 MCP tool，不修改宿主配置，也不要求任何插件；sidecar 是**无宿主依赖的 fallback**，不冒充真实用户回合。

`countScope=tool_call` 只数 `cg`/`stg`，**看不见 `mdcg_remember` 等写工具**——
需要按写入节奏巡检时用 `all_tools`。

## 状态文件

| 文件 | 内容 |
|---|---|
| `state/sidecar-counter.json` | 计数 / 分工具计数 / 各档口最后唤醒轮次 |
| `state/sidecar-wake-signal.json` | 当前档口信号（含 `status` / `network` / `source`） |
| `state/sidecar-wake-history.jsonl` | 唤醒历史（追加） |
| `state/sidecar.log` | 运行日志（含门禁跳过原因，便于诊断「为什么没触发」） |
| `state/runtime.json` | Alpha-Dog runtime 状态（轮次、批次、已处理事件、挂账） |

`status` 取值：`pending` / `observed` / `done` / `degraded` / `no-plan` / `skipped` / `failed`。
**`degraded` 表示模型不可用、唤醒已挂账，不是成功。**

## 验证

```bash
cd engine
npm test              # 含 sidecar 真链用例：握手 + tools/list + On/Off + 计数 + 唤醒
```

`test/sidecar.test.mjs` 会真起 bridge 与 Python 内核，断言：
`initialize` 握手成功、`tools/list` 暴露 `Alpha_Dog_On/Off`、`On` 后计数增长并产生 `light` 信号、
`Off` 后计数冻结。全部使用临时 `MDCG_ROOT` / `STATE_DIR`，不触碰真实记忆。
