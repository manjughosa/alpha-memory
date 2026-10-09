# Alpha Memory 记忆召回链路升级方案

- 版本：1.0
- 日期：2026-10-09
- 状态：阶段 0 基线已完成；阶段 1 合同与安全验收进行中；向量后端尚未接入

## 1. 大目标与边界

只升级 Alpha Memory 现有记忆召回链路：在现有多路候选检索中增加本地向量候选，并与当前 lexical、bucket、entity、graph 路径融合，最终仍走资格过滤、secure 权限过滤和 token-budget 装包。对外继续使用同一个 `mdcg_recall` MCP 工具和现有返回包；不新建 MCP、不替换 canonical memory store、不改写入/审核/遗忘业务；为兑现已确认的共享 root 多租户策略，仅补上节点 tenant 归属校验及旧节点显式管理员迁移，不要求批量迁移真实记忆。

成功标准：对无直接词面重合的改述问题有可测召回提升；现有时效、会话、角色、敏感度、预算裁剪和返回契约不回退；共享 root 中 tenant 必须由 Principal 写入节点元数据并在每个 secure 读取/召回入口校验，旧节点无 tenant 时 fail-closed、仅允许管理员逐节点显式绑定；向量索引可从 canonical memory 重建；任何向量后端失败均可观测且可回退。

## 2. 当前实现与已测基线

### 2.1 召回调用链

1. `engine/md_cg/mcp_server.py` 注册并分派 `mdcg_recall`。
2. handler 调用现有 `MdCGSecure.recall()`，MCP 工具面保持不变。
3. `engine/md_cg/mdcos.py` 的 `MdCGOS.recall()` 调 `search_rrf()`，再执行 token-budget 装包、单条截断和近期事件附加。
4. 当前 `paths=None` 维持旧默认四路：`lexical`、`bucket`、`entity`、`graph`；MCP 的 fuzzy/semantic/goal 开关关闭时不会显式改写路径集合。RRF 使用现有融合方式，候选随后经过资格、secure 可见性与时效等规则。
5. `MdCGSecure` 将 tenant 与 clearance/sensitivity 用于读写隔离；`private`/`secret` 正文可加密。召回必须继续以 secure store 为最终授权和正文来源。

### 2.2 MCP 默认参数

- `k=20`；`budget_tokens=1200`；`max_item_tokens=250`。
- handler 未传 `judge`，由 `MdCGOS.recall()` 的默认值 `judge=True` 生效。
- `paths=None` 时使用引擎原有默认检索路径。
- `include_work=False`，近期事件默认不附加；时效过滤缺省关闭。
- 本轮已扩展合成 runner，可显式传入并记录 `judge` 与 `max_item_tokens`；没有改变旧 engine-level runner 的默认参数。

### 2.3 可复现合成基线

仅在临时目录中创建合成 secure store，使用临时派生密钥；未读取 Alpha 用户级 root、真实记忆或凭据。

| 项目 | MCP 默认参数对齐结果 |
|---|---:|
| 语料 / 问题 | 1,000 条合成事件 / 180 个问题，六类各 30 题 |
| Recall@1 / @5 / @10 | 0.9167 / 0.9167 / 0.9167 |
| MRR@10 / Precision@5 | 0.9167 / 0.1833 |
| miss | 15 / 180 |
| p50 / p95 | 1542.0–1599.5 ms / 1790.7–1836.1 ms（本轮两次 warm run，仅作参考；机器负载会影响时延）|
| 截断条目 / 跳过条目 | 30 / 420 |
| paraphrase：有词面重合 | 15/15 命中，Recall@10=1.0 |
| paraphrase：无词面重合 | 0/15 命中，Recall@10=0.0 |
| fixture hash | events `dcd43bb2305f7684df8ccf0aaa0079612a93c3e0463796d39a17af8c56fd71f5`；questions `026435606e7c1e086b82a53b86273bc7341df9c89dda911a4b3dc6293cfde889` |

### 2.4 关联但未修改的摄取水位风险

对 `engine/md_cg/sources.py` 的代码核查发现：`Ingestor.ingest()` 捕获 `cg.add()` 异常后计入 `denied` 并继续；批次末尾只要 `new_events` 非空，仍将 watermark 写到最后一个事件。若较早事件写入失败，后续增量可能跳过该失败事件。此行为不属于本次召回链改造，未修改；向量索引同步不得复用该摄取 watermark，应有独立的 durable checkpoint 与 reconciliation。P29 现有测试覆盖正常重跑幂等，未覆盖这类失败场景。若要修复 ingestion，需单独授权并按 TDD 立项。

因此已观察到的明确短板是“无词面重合改述”，不是泛化地宣称当前所有检索都差。数据集小、纯合成；结果不能外推为真实生产效果。

可复跑命令见本目录 `engine/md_cg/README.md` 的“与 MCP 默认参数对齐”一节。

## 3. 目标架构

### 3.1 不变的边界

- MCP facade：工具名、参数、返回结构不变，不新增 MCP server/tool。
- Canonical source：原 MdCG Markdown/索引仍是真源；向量库是可丢弃、可重建的派生索引，不单独成为记忆事实源。
- Authorization：向量库返回的 ID 不是授权结果。候选必须与当前 `MdCGSecure` 可见候选求交；正文只能由 secure store 按调用者身份读取。tenant/filter 是纵深防御，不能替代 `_readable` / clearance 检查。
- Packing：现有资格判断、有效期/时间过滤、RRF provenance、`budget_tokens`、`max_item_tokens`、近期事件与 `pack` 返回格式继续由原链路负责。
- 写入与生命周期：第一版不改 `mdcg_remember`、writepipe、审核、forget/restore 和 source ingest 的业务语义；只在 canonical 写入已提交后更新派生向量索引。

### 3.2 查询数据流

`mdcg_recall` → 现有 MCP 参数解析/身份 → secure 候选资格过滤 → 本地 query embedding → 本地向量库取 top-N ID/rank → 与 secure 候选 ID 求交并使用 canonical 节点信息 → 与现有检索路由形成 `vector` ranked path → 现有 RRF/fusion 与 qualification → secure 二次过滤 → 现有预算装包 → 原 MCP response。

向量路径先以 shadow 模式运行，仅比较排名和指标，不影响用户实际返回。经过门槛后，才通过现有 `paths`/内部 feature flag 启用 hybrid；停用 flag 后立即回到原四路。

### 3.3 向量索引约束

- 首选评估 Qdrant 本地部署/本地模式；最终选择前先确认同一 root 是否可能被多个 MCP 进程同时打开。若单进程本地模式不满足现有部署拓扑，比较本机 Qdrant service 与轻量嵌入式方案，禁止暗中启动远程服务。
- Embedding 必须由本地模型执行，不调用云端 embedding API。模型名称、版本、维度、归一化方式和文件摘要写入索引 manifest；升级模型或维度时新建版本索引并完整重建，不能混用向量。
- payload 只存 node id、tenant、sensitivity、layer、role、session、branch、时效字段、正文 hash、模型/索引版本等必要元数据；不复制正文。向量本身也按敏感派生数据处理，索引目录必须留在对应用户数据边界并受磁盘加密/ACL 保护，不得进仓库、日志或云端。
- tenant 与 sensitivity/session 等 metadata filter 用于缩小候选；最终授权始终由当前 secure store 重验。缺失或无法解析的权限元数据不得放宽过滤。
- 每个节点以稳定 id + canonical content hash + embedding model version 作为幂等键。update/forget/restore/merge 的失效和重建路径必须明确；索引更新失败要留下可检测的 dirty/stale 标记，不能报告“向量同步成功”。
- 向量库和 Markdown 真源无法跨存储原子提交。实现前必须确定 canonical commit 点以及可恢复 reconciliation 机制；启动/维护时能扫描 hash 差异并补齐。索引损坏时可删除派生索引并重建，不触碰 canonical memory。
- hybrid 排序按 rank/RRF 融合，不直接把 cosine 原始分数与现有路由分数相加。向量路的 candidate limit、RRF 常数/权重通过离线评测确定并固定在配置与报告中。

### 3.4 错误与回退

向量后端不可用、模型缺失或 manifest 不兼容时，不伪造向量命中、不静默吞错。若 legacy 路径仍可服务，可显式降级到原路径并在 response metadata/诊断日志记录 `vector_status=degraded`、原因与计数；无法保证权限过滤时必须 fail-closed。回退不得改写或删除 canonical memory。

## 4. 分阶段实施与验收点

| 阶段 | 工作与技术点 | 验收标准 / 退出条件 |
|---|---|---|
| 0. 基线冻结（已完成） | 固定 seed、1,000 synthetic events、180 questions、六类问题；manifest/hash；排名指标；临时 `MdCGSecure` root/临时 key；engine 默认与 MCP 默认参数分开报告。 | MCP 对齐报告确认为 `k=20,budget=1200,judge=True,max_item_tokens=250,paths=None`；hash 可复现；真实 root/密钥没有进入 runner；记录 15 个 no-overlap miss。定向测试已覆盖 runner 契约。 |
| 1. 合同与安全基线（进行中） | 锁定 MCP schema/pack 形状；在临时数据上测试共享 root tenant 所有权、legacy 未绑定节点、clearance/sensitivity、session、expired 节点与 vector candidate 不越权；测试 canonical node read containment 与后续派生索引路径分离；审计 recall 结果的 provenance/截断/跳过字段。 | 原四路 baseline 无回归；新增节点 tenant 来自 Principal 且不可伪造/越权覆盖；不同 tenant 对 recall/get 命中数=0；无 tenant legacy 节点默认不可见，显式 admin 逐节点绑定后仅目标 tenant 可见；越出 canonical root 的节点索引路径在 get/_read 拒绝；MCP 工具名/schema 不新增；测试只读写临时目录。来源 ingest watermarks 不复用为向量 checkpoint；已有失败水位风险见 §2.4。 |
| 2. 后端与 embedding 选型 | 比较本机进程拓扑兼容的 Qdrant 部署方式；比较至少两个本地 embedding 候选的中文/英文/混合改述、CPU/RAM/模型大小、冷启动与 warm latency；明确 license、版本锁定、缓存目录、离线运行和磁盘保护要求。 | 固定模型文件摘要与向量维度；离线无网络运行；所有 180 题可复现；no-overlap paraphrase Recall@10 至少 0.70，整体 Recall@10 至少 0.95，Precision@5 不低于 0.1833；1k corpus warm p95 ≤ 2 秒。若达不到，暂停并重新选型，不写生产路径。 |
| 3. 派生索引与生命周期 | 实现单一 retrieval adapter 与 versioned vector index；建立提交后同步/dirty 标记/reconcile/rebuild；处理 add/update/forget/restore/merge 与 model-version 切换；metadata filter 后仍经 secure candidate intersection。 | 多次重建结果 ID/rank 可重复；同一写入重复同步不产生重复点；更新后旧 hash 不可召回；忘记/删除后无 stale ID 回流；索引损坏可完整重建；跨 tenant/clearance/session/validity 拒绝数为 0；故障有明确降级状态。 |
| 4. Shadow hybrid 对比 | 对固定 fixture 同时跑 legacy 与 hybrid；记录每题排名、per-path provenance、query/embed/vector/pack latency、miss、截断/跳过；不改变真实 MCP 返回。 | no-overlap Recall@10 ≥ 0.70；overall Recall@10 ≥ 0.95；现有 overlap paraphrase Recall@10 ≥ 0.95；Precision@5 ≥ 0.1833；所有安全断言全通过；p95 ≤ 2 秒；输出含模型/索引/fixture hashes。任何一项失败不进入 canary。 |
| 5. 灰度与回滚 | 通过现有 MCP 内部配置选择 `legacy`/`shadow`/`hybrid`，默认 legacy；逐步启用 hybrid；仅重建派生索引；保留开关即时回退。 | MCP 调用方不改配置、不改工具/schema；错误率和 latency 不越门槛；回退后指标/响应恢复 legacy；回滚只停用/重建 vector sidecar，不触碰 canonical nodes。 |
| 6. 稳定化 | 检查长跑的资源占用、重启、并发、manifest 漂移和重建；补齐部署与运维文档。 | 连续重启/重建验收通过；无未处理 stale index；文档列明备份、重建、回退与诊断操作；默认策略和所有已知限制可被维护者复现。 |

### 当前进度

阶段 0 已完成。阶段 1 已完成 runner 参数透传与 MCP 默认参数隔离基线；本轮在临时 root 合成测试中复现并修复共享 root 跨 tenant 可读问题：新节点由 Principal 写入 tenant，secure get/候选/RRF/recall 校验租户归属，缺 tenant 的 legacy 节点默认拒绝，并提供 admin-only 的 `MdCGSecure.bind_legacy_tenant(node_id)` 逐节点显式迁移；不新增 MCP 工具。当前重新运行的 synthetic security 模块 9 项全通过，覆盖 tenant/sensitivity、get/secure read、基类 search 与 secure 负向记忆越界读取、统一节点写盘拒绝 root 外目标；本轮另重跑 P0 核心验收 25 项和 P45 会话身份 31 项，均通过。身份归属 14 项、P13 encryption 42 项、MCP 集成 64 项通过；另有 tenant registry 33 项、近期事件/goals 36 项、P26 refindex 59 项、P28 refcheck 45 项及 P29 session ingest/export 48 项通过（这些为前序验证，不代表本轮重跑）。`test_md_access_parity` 因所需 `_md_cg_wisdom_graph` 数据集不存在而显式 SKIP，未伪造数据。向量 sidecar 尚未实现，因此派生索引路径分离仍属后续验收；sources watermark 风险见 §2.4。未改动召回打分/排序/装包算法，未安装依赖，未接 Qdrant 或 embedding model。

## 5. 回退与变更纪律

1. 新向量索引始终可再生；不得作为 canonical memory 的唯一副本。
2. 切换开关默认 legacy；未经阶段 4 验收不得改变默认行为。
3. 出现权限失败、路径越界、索引/真源不一致或不透明降级，立即禁用 vector path，保留证据并修复，不以更大的 top-k 掩盖。
4. 清理派生索引前必须 dry-run 列出确切路径与文件数；不递归删除未知 root。
5. 所有评测继续只用合成 fixture。真实记忆试验需单独授权、备份、脱敏和访问边界审查，本方案不构成该授权。

## 6. 尚待阶段门确认的决定

- 目标机器的 RAM/CPU、允许的本地模型体积以及模型缓存存放位置。
- 多 tenant 可共享同一个记忆 root（节点级 tenant 已 fail-closed）；该 root 是否会被多个 MCP server process 并发打开仍待确认，它决定 Qdrant local mode 是否可用。
- 是否接受 Qdrant 本机 service，还是必须无独立服务进程。
- 通过阶段 2 的精确 embedding 模型、license 与升级策略。
- Stage 5 的灰度开关作用域和启用时长。

这些决定不阻塞阶段 0/1 的合成测试，但在任何依赖安装、模型下载或真实索引改造前必须确定。全程维持“单一 Alpha Memory MCP；只替换其召回链内部件”的产品边界。