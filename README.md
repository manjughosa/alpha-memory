# Alpha-Memory

> **版本**: v0.4.x | **最后更新**: 2026-10-10

Alpha-Memory 是面向 AI Agent 的本地长期记忆系统；Alpha-Dog 是其增量维护调度器。

记忆内核是一个标准 stdio MCP server，**宿主无关**——任何支持 MCP 的工程端都能直接接，内核里不含任何宿主专属代码。

---

## ⚡ 5分钟快速开始

### 1. 克隆并测试内核
```bash
git clone https://github.com/manjughosa/alpha-memory.git
cd alpha-memory/engine
python md_cg/datapath.py
# 应打印：State root: ~/.alpha-memory
```

### 2. 添加到你的 MCP 配置
在你的 MCP 客户端配置中加入：
```json
{
  "mcpServers": {
    "alpha-memory": {
      "command": "node",
      "args": ["<path-to>/alpha-memory/engine/runtime/alpha-dog-sidecar.cjs"],
      "env": {
        "ALPHA_MEMORY_HOME": "<path-to>/alpha-memory"
      }
    }
  }
}
```

### 3. 验证连通
在你的 Agent 中调用：
```python
alpha_memory_recall(query="测试")
# 应返回记忆列表（可能为空，这是正常的）
```

✅ **成功！** 详细配置见下方完整文档。

---

## 📖 使用示例

### 基础记忆操作
```python
# 记住一件事
alpha_memory_remember(content="用户喜欢喝咖啡，每天早上必喝拿铁")

# 回忆相关内容
results = alpha_memory_recall(query="用户的兴趣爱好")

# 精确读取（已知节点ID）
node = alpha_memory_get(node_id="xxx")
```

### 🚀 向量语义搜索（新特性）
```python
# 纯向量召回
results = alpha_memory_recall(query="饮品偏好", vector=True)

# 多路径融合（推荐）
results = alpha_memory_recall(
    query="用户是谁", 
    vector=True,   # 向量语义
    fuzzy=True,    # 词法匹配
    semantic=True  # 条件匹配
)
```

详见 [VECTOR_RECALL_GUIDE.md](VECTOR_RECALL_GUIDE.md)

### Alpha-Dog 自动维护
```python
# 开启看门狗
alpha_dog_on()

# 之后每15/21/30轮会自动巡检和维护记忆
# 无需手动提醒
```

---

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

---

## ❓ 常见问题（FAQ）

### Q1: 记忆数据存储在哪里？
默认存储在 `~/.alpha-memory/data/mdcg`（纯 Markdown 格式）。可通过环境变量 `ALPHA_MEMORY_HOME` 自定义位置。

### Q2: 如何备份我的记忆？
直接复制 `~/.alpha-memory/data/` 目录即可。记忆以 Markdown 格式存储，易于备份和版本控制。

### Q3: Alpha-Dog 的15/21/30轮是什么意思？
这是自动维护的触发间隔：
- **15轮**：轻量级即时落盘
- **21轮**：系统巡检（索引、冲突检测）
- **30轮**：深度记忆巡检（优化、质量评估）

### Q4: 向量召回需要额外配置吗？
需要 Qdrant 向量数据库（支持本地模式）和嵌入模型（默认 `qwen3-embedding:0.6b`）。详见 [VECTOR_RECALL_GUIDE.md](VECTOR_RECALL_GUIDE.md)

### Q5: 出现 "API key not found" 错误怎么办？
检查 `~/.mdcg/` 下的凭据配置，或在 `alpha-dog.setting.json` 中配置 `apiKeyRef` 引用。

### Q6: 如何验证 Alpha-Dog 正常工作？
调用 `alpha_dog_status()` 查看运行状态，或检查 `engine/state/runtime.json` 的 `wakeCount` 是否递增。

### Q7: 可以在多个项目间共享记忆吗？
可以。所有使用相同 `ALPHA_MEMORY_HOME` 的 Agent 共享同一记忆池。不同项目可设置不同路径实现隔离。

### Q8: 记忆内核支持哪些 MCP 客户端？
任何支持 stdio MCP 的客户端（Claude Desktop、Cline、Continue 等）。内核是宿主无关的标准 MCP server。

---

## 📚 相关文档

- [完整配置指南](engine/README.md) - 详细的安装、配置和开发说明
- [向量召回指南](VECTOR_RECALL_GUIDE.md) - 向量搜索功能使用指南
- [Agent 接入指南](engine/AGENT-SETUP.md) - 快速接入指南（可直接给 Agent）
- [Sidecar 运行时](engine/runtime/README.md) - MCP stdio 事件源说明

---

## 📄 许可证

详见项目根目录 LICENSE 文件。

---

**Alpha-Memory** - 让 AI Agent 拥有长期记忆 🧠
