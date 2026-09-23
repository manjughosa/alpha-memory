# Alpha-Memory

Alpha-Memory 是面向 AI Agent 的本地长期记忆系统；Alpha-Dog 是其增量维护调度器。

记忆内核是一个标准 stdio MCP server，**宿主无关**——任何支持 MCP 的工程端都能直接接，
内核里不含任何宿主专属代码。

## 对外接口与治理边界

Alpha-Memory 有两个不同的接入面，不能混为一谈：

| 接入面 | 默认接口 | 作用 |
|---|---|---|
| Alpha-Dog MCP 控制面 | `Alpha_Dog_On`、`Alpha_Dog_Off` | 看门狗上电/断电、计数、调度和状态保存 |
| 记忆内核直连 MCP 面 | `cg`、`stg` | Alpha 本体的认知图与时空图读写/查询入口 |

`mechanical`（机械降级）、`degraded`（降级挂账）、熔断、批次、注册表、反馈和审计都属于内部运行层，**不单独占用对外接口，也不注册成第四个工具**。模型不可用时，Alpha-Dog 仍可计数、建计划、挂账和保存状态，但不调用模型、不伪造成功。

治理分层如下：

- **P0**：降级、熔断、输入校验、失败挂账、快照回退和可恢复运行，落在 `AlphaDogGovernance` 与 Alpha-Dog runtime。
- **P1**：原子记忆实体、受控关系类型、资源更新通知和结构化写入回执，落在 Memory contract 与反馈闭环。
- **P2**：状态头部、未决队列、批次账本和验收铁闸，落在持久化 state、wake queue、batcher 和审计状态。
- **P3**：15/21/30 档口、连续唤醒、watchdog prompt 和 shadow/正式切换，属于 Alpha-Dog 驾驶逻辑。

以上分层是当前主链的落点划分；更细的来源与取舍属于内部过程记录，不随发行物分发。

## 项目结构

- `engine/`：记忆内核（Python，`engine/md_cg/`）、测试与构建脚本。
- `alpha-dog.setting.json`：Alpha-Dog 默认配置。
- `alpha_memory_bridge.js`：项目路径与运行入口桥接，同时是安全边界（凭据、策略、咽喉闸）。
- `engine/runtime/alpha-dog-sidecar.cjs`：MCP stdio 事件源，包裹 bridge 并在 Node 侧唤醒 Alpha-Dog。
- `alpha_policy_check.py`：发布前治理检查。
- `alpha_normalize.js`：内容归一化工具。
- `alpha_review_rules.json`：审核规则。

> **记忆和凭据不在仓库里。** 记忆默认落 `~/.alpha-memory/data/mdcg`（纯 Markdown），
> 凭据默认落 `~/.mdcg/`。仓库里不会有 `data/` 或 `token/` 目录，这是有意为之——
> 更新仓库不会删你的记忆，把仓库传给别人也不会带走你的记忆。
> 想改到别处、或想放进仓库一起备份，见 [engine/README.md](engine/README.md) 的
> 「仓库里为什么没有 `data/` 和 `token/`」。

## Alpha-Dog 部署状态与发行边界

Alpha-Memory / Alpha-Dog 的交付形态是 **MCP 内核 + MCP 运行时库**，不是宿主插件。发行物不携带、不安装、不依赖 DSH 插件、插件入口或插件 hooks。

宿主侧回合事件不依赖插件，也**不需要 Agent 自己记得提醒**。默认事件源是随包 sidecar：把 MCP 配置的 `command` 指向 `engine/runtime/alpha-dog-sidecar.cjs`，它在 MCP stdio 接缝上计数，并在档口于进程内唤醒 Alpha-Dog runtime。sidecar 包裹现有 `alpha_memory_bridge.js`，因此凭据注入、策略文件和咽喉闸仍然生效；它不修改宿主插件配置。

sidecar 的默认计数口径是**记忆工具调用次数**，不是真实对话轮：一个回合调 3 次 `cg` 记 3 次，一次不调记 0 次。需要严格轮语义时，客户端 Agent 向同一 MCP stdio 连接发送内部 JSON-RPC notification `alpha-dog/round_tick`；它不注册为 tool、不安装插件、不修改宿主 hooks。sidecar 是无宿主依赖的 fallback，不冒充真实用户回合。细节见 [`engine/runtime/README.md`](engine/runtime/README.md)。

研发环境采用“先并行、后切换”的流程：`legacy` 保留旧链，`shadow` 运行新链但禁止正式写入，只有至少三轮完整双链对账通过后才允许进入 `alpha_dog`。发行包默认不会自动启动 Alpha-Dog：`enabled=false`、`state.mode=legacy`、`sidecar.enabled=false`，也不会携带研发环境的模型、凭据、运行状态或 Shadow 报告。

发行包安装后可在 `engine/` 下运行只读自检：

```bash
npm run doctor
```

安全默认值应为 `enabled=false`、`initialization.status=unconfigured`、`state.mode=legacy`；`apiKeyRef` 只能是密钥引用名，不能填写真实 API key。首次 `Alpha_Dog_On` 会返回结构化初始化请求，初始化完成后仍应先保持 `shadow`，不要跳过双链验证直接切换正式链。

第 30 轮可能同时命中 15 轮 light 档和 30 轮 heavy 档，因为 15 是 30 的约数；这是规划中“同一轮多个档口建立多个 wake plan”的预期行为，执行顺序由 `simultaneousOrder` 决定。

## 开发

```bash
cd engine
npm install
npm run build
npm test
npm run test:python
npm run doctor
npm pack --dry-run --json
```

完整的接入、配置与验证说明见 [engine/README.md](engine/README.md) 与 sidecar 专页 [engine/runtime/README.md](engine/runtime/README.md)。
要接入宿主，把 [engine/AGENT-SETUP.md](engine/AGENT-SETUP.md) 丢给 Agent——它探测宿主、把 `command` 指到 sidecar、跑验证。

## 鸣谢

本项目的产品代码为自主设计与实现，以下项目提供了**设计参照**：

- [Omega-Memory](https://github.com/omega-memory/omega-memory)（Apache-2.0）—— 分层降级、熔断、校验与评估这一问题域上的工程参照
- [MCP Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)（MIT）—— 原子化纪律与关系类型受控的理念对照
- [dsh-memory](https://github.com/FuRongJun-1999/dsh-memory) —— 感谢其公开的工程思路

完整的依赖披露见 [engine/README.md](engine/README.md) 的「鸣谢」一节。
