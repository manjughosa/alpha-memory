# md_cg · 记忆内核模块地图

这个目录是 Alpha-Memory 的记忆内核：**约 220 个文件、8.3 万行 Python**。
它把对话沉淀为纯 Markdown 的认知图，并对写入、检索、演化做确定性裁决。

本文件是**导航**：告诉你每个模块干什么、数据怎么流。
每个模块自己的头部还有 `生效条件：<前置>时，<行为>，返回 <结果>` 契约注释，
共 1900 余处，是比本文件更精确的真源。

> 阅读顺序建议：先看「数据流」一节建立整体印象，再按需跳到对应分组。

---

## 一、数据流

```
外部会话 / 文件 / 设备
        │
        ▼
  sources.py（摄取源）─┐
        │             │
        ▼             ▼
  ┌─────────────────────────────┐
  │  写入链路（闸门即扩展）        │
  │  writepipe → audit →         │
  │  writelimit → forgetting →   │
  │  twophase（两段式提交）        │
  └─────────────┬───────────────┘
                │  ACCEPT / REJECT / DEFER / BLINDSPOT
                ▼
  ┌─────────────────────────────┐
  │  记忆基底（原文即真源）        │
  │  nodefile（节点格式）          │
  │  mdcg / mdcos（存储与认知）    │
  │  fsutil（原子写 / 锁 / 日志）  │
  │       ↓ 落盘为 .md            │
  └─────────────┬───────────────┘
                │
                ▼
  ┌─────────────────────────────┐
  │  索引与检索（派生物，可重建）   │
  │  refindex / docindex /        │
  │  codeindex / postings /       │
  │  subgraph / reach / chain /   │
  │  pooling / progressive        │
  └─────────────┬───────────────┘
                │
                ▼
  mcp_server.py（对外 MCP 工具面：cg / stg）
                │
                ▼
  宿主（DSH / 任意 MCP 客户端）
```

**一句话**：Markdown 是唯一真源，索引只是加速器；写入过闸门，读取可归因。

---

## 二、模块分组

### 1. 记忆基底（存储与格式）

| 模块 | 职责 |
|---|---|
| `mdcg.py` | md 认知图的存储、检索与认知循环 |
| `mdcos.py` | 记忆操作系统扩展（MdCGOS），上层编排 |
| `nodefile.py` | 节点文件格式：YAML-ish frontmatter + CCG 正文 |
| `fsutil.py` | 文件系统原语：原子写 / 跨进程锁 / append-only 日志 |
| `datapath.py` | 数据根解析（记忆写入路径可配置，支持环境变量与 paths.json） |
| `hotcache.py` | 热路径缓存：节点缓存 + 查询结果缓存 |

### 2. 对外接口

| 模块 | 职责 |
|---|---|
| `mcp_server.py` | MCP server（记忆操作系统对外接口），工具面与 JSON-RPC 主循环 |
| `stg.py` | 语义时空图接口（STG）：信息的时间 / 空间关系 |
| `protocol.py` | 记忆动词协议 v1（单一真源） |
| `statushdr.py` | 状态摘要协议（MCP 输出面一等公民） |
| `tool_face.py` | 工具面渐进披露（上下文经济学） |
| `selfreport.py` | 常驻进程自报：我是谁 / 从哪个包加载 / 持哪一代契约 |

### 3. 权限与安全

| 模块 | 职责 |
|---|---|
| `security.py` | 进程 / 权限模型（记忆 OS #2） |
| `tokens.py` | 令牌与角色权职分离（记忆 OS #3） |
| `crypto.py` | 用户私有内容的端到端加密（静态加密），密钥即访问权 |
| `signer.py` | 签名接口层 |
| `protect.py` | 自我层 / 锚点层写保护（不可遗忘） |

### 4. 写入链路

| 模块 | 职责 |
|---|---|
| `writepipe.py` | 写入路径拦截器链（闸门即扩展） |
| `audit.py` | 写入审核：按内容类型分派的验证体系 |
| `writelimit.py` | 自动写入限流与同构聚合（流水污染治理） |
| `forgetting.py` | 主动遗忘闸门（写入情景层前的三问筛选） |
| `twophase.py` | 写入两段式提交：先记意图再记结果，崩溃后可对账 |
| `lifecycle.py` | 节点显式生命周期状态机 |
| `policy.default.json` | 随包默认规则库（禁止项；未显式配置时回落使用） |

### 5. 条件空间（本项目核心机制）

| 模块 | 职责 |
|---|---|
| `condition_anchor.py` | 判定候选「生效条件」是否锚定在符号真实输入 / 状态上 |
| `cond_facts.py` | 条件事实提取（白箱写注释的原料，确定性、零 LLM） |
| `cond_compose.py` | 白箱条件填充器：把事实按模板填成功能级生效条件 |
| `routing.py` | 路由键归一化 |
| `census.py` | 条件空间分布普查 |
| `weights.py` | 位置权重矩阵（不同身份，参数偏好不同） |

### 6. 检索与索引

| 模块 | 职责 |
|---|---|
| `refindex.py` | 统一 ref 协议 + 索引水位（增量）+ 漂移 / 悬空巡检 |
| `docindex.py` | 条件文档图：按章节索引 md 文档，不存全文 |
| `codeindex.py` | 条件代码图：按注释 / 接口索引代码，不存完整代码 |
| `postings.py` / `build_postings.py` | 倒排发布表：不读遍全库即可取词法候选 |
| `subgraph.py` | 嵌套子图：结构要素的可递归表示 + flatten |
| `reach.py` | 检索候选收敛层：大域收敛 → 条件门控 → 图扩散 |
| `chain.py` | 关系链 / 因果链遍历（因果链即条件链） |
| `pooling.py` | 召回分池与降权（索引类节点不吃全局截断额度） |
| `progressive.py` | 渐进式语义检索控制器 |
| `links.py` / `linkref.py` | 连接层与正文裸 id 引用建链 |

### 7. 固化与维护

| 模块 | 职责 |
|---|---|
| `consolidate.py` | 离线固化：补 CCG 四要素 → 确定性验证 → 固化为 md 字段 |
| `backfill.py` / `backfill_bigdomain.py` | 库对齐回填：CCG 回填 + 能力标签注入 |
| `scrub.py` | 记忆自净：抽查 / 联想 / 去污染 / 校准偏差 |
| `sustain.py` | 持续性自维持：常驻 / 心跳 / 自愈 / 会话续接 |
| `evolution.py` | 演化账本：每次修改 = 对一条缺失条件的补充 |
| `branches.py` | 记忆演化分支（fork） |
| `lifecycle.py` | 见「写入链路」 |

### 8. 认知层

| 模块 | 职责 |
|---|---|
| `self_state.py` | 自我状态层：薄自我 + 富索引 |
| `metacognition.py` | 独立元认知：观察自身认知过程的二阶单元 |
| `identity.py` | 身份特征识别（主体 × 位置效应 × 条件特征） |
| `insight.py` | 洞察条件层：洞见事件四件套 |
| `predict.py` | 生成式预测：候选未来路线（非必然未来） |
| `d_meta.py` | D_meta 投影：边界压力向量（三代理，不合成单值） |
| `autonomy.py` | 信息差驱动的自主探索闭环（提案 → 验证 → 回写） |
| `theory.py` | 版本层：公理状态，声明不合法时禁写事实层 |
| `trust.py` | 可验证记忆单元：验证态状态机 + 依赖图 + 双时间轴 |

### 9. 一致性与核验

| 模块 | 职责 |
|---|---|
| `consistency.py` | 节点间自动冲突检测（三级决策） |
| `conformance.py` | 数据健康不变量断言集 + 类型空间正交性审计 |
| `crosscheck.py` | 批量核对：工单 → 反思候选 → 白箱闸门 → 验证否决 → 来源执照 → 落库 |
| `evidence.py` | 跨节点证据存储 |
| `provenance.py` | 派生溯源：新增节点常态化建链 + 悬空可检出 |
| `coldverify.py` | 冷路径异步深度验证队列 |
| `vision_evidence.py` | 视觉证据回填（守卫式 / 零 LLM / 不读图像） |
| `hyperedge.py` | 超边：跨端验证回执的认知图形式化投影 |
| `units.py` | 复核单元接线层（单元池优先 → 提示配置 → 宿主端子代理降级） |
| `refine.py` | 结构提炼：小样本抽检工单与扩批闸门 |

### 10. 白箱能力

| 模块 / 目录 | 职责 |
|---|---|
| `whitebox.py` | 白箱能力调用与验证（显式调用层） |
| `md_whitebox.py` | md 原生知识库的白箱问答 |
| `ccgc.py` | 对话记录 → CCG 六要素编译器 |
| `comment_gate.py` | 代码符号「条件化注释」抽样闸门 |
| `whitebox_kb/` | 白箱子系统：条件化单元与组合引擎（约 5.6 万行） |

### 11. 任务与角色

| 模块 | 职责 |
|---|---|
| `tasks.py` | 结构层任务实体（structural 层正式业务写入口） |
| `roleviews.py` | 角色化读取视图 |
| `blindspot_tickets.py` | 盲区消解票据：BLINDSPOT / DEFER → 四类消解任务卡 |

### 12. 迁移、导出与评测

| 模块 | 职责 |
|---|---|
| `migrate.py` / `migrate_aeis.py` / `migrate_roleplay.py` / `migrate_wisdom_graph.py` | 各类历史数据迁移到 md 认知图 |
| `export.py` | 全库导出 |
| `sources.py` | 设备驱动：把外部会话流接进认知图 |
| `corpus.py` | 验收共用的自建 md 语料 |
| `eval_common.py` / `bench*.py` | 公开基准评测与横评口径层 |

### 13. 子目录

| 目录 | 职责 |
|---|---|
| `lexicon/` | 词典与字词资源 |
| `mreview/` | 记忆评审管线 |
| `protocol/` | 协议定义 |
| `semantic/` | 语义结构与检索（含 SCHEMA.md / REPRODUCE.md） |
| `whitebox_kb/` | 白箱子系统 |
| `test_*.py` | **117 个测试文件**，覆盖内核 / 协议 / 权限 / 并发 / 治理 / 回放一致性 |

---

## 三、名词对照

| 名词 | 含义 |
|---|---|
| 认知图 / CG | 节点 + 边的记忆网络，即 md_cg 的主体 |
| STG | 语义时空图接口：时间与空间关系查询 |
| CCG | 六要素条件模板（功能名 / 生效条件 / 子功能 / 执行 / 验证方式 / 不适用条件） |
| 条件空间 | 每条记忆携带的显式生效条件（载体 / 位置、时间窗、观测方法、存在性约束） |
| 四态判定 | `ACCEPT` 落盘 / `REJECT` 拒绝 / `DEFER` 转审核队列 / `BLINDSPOT` 信息不足不冒充接受 |
| 真源 | Markdown 原文；索引是派生物，可随时重建 |
| 闸门 | 写入路径上的拦截器，决定一条内容能否进入记忆 |

---

## 四、怎么跑

```bash
cd engine

# 全量测试（117 个文件）
npm run test:python

# 单个模块测试（示例）
python -m md_cg.test_p27_docindex

# 查看数据根解析结果
python md_cg/datapath.py
```

无对应数据面的用例会**显式 SKIP**，不虚报通过。
