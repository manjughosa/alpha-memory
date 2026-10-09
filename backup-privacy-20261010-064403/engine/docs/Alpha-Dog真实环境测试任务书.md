# Alpha-Dog 真实环境测试任务书

任务发起：zyq（2026-09-23）｜执行：苏苏｜目的：真实环境验证 Alpha-Dog 自驱敲醒全链路

## 一、背景（必读）

Alpha-Dog 是 Alpha-Memory 的驾驶舱，架构如下：

- **sidecar**（`engine/runtime/alpha-dog-sidecar.cjs`）：MCP 接缝上的观察者。它包装 alpha_memory_bridge.js（Alpha 记忆内核入口），并在后台**每 10 秒自驱轮询**对话源（PI 会话 jsonl），数 user 消息数 = 真实对话轮。
- **runtime**（`engine/lib/alpha-dog.js`）：驾驶舱核心。轮次以**对话源为权威**（第 N 条用户消息写入 jsonl → N%15==0 立即触发 15 档，不等下一轮），counter 只是 fallback，不会吞轮。
- **档口**：15（light，即时落盘，backfill+monitor）/ 21（medium，backfill+monitor）/ 30（heavy，interrupt+fixed_defer+backfill+monitor）。
- **触发后**：加载对应说明书（`engine/prompts/alpha-dog-*.md`）→ 调 DeepSeek 模型（network=on）→ 生成候选 → 占位符评估（windowText/topicClosed/mode）注入请求 → 狗判断 → 反馈闭环 → 存档后挪占位符。
- **当前真实对话轮：10**（距 15 档还差 5 轮）。

## 二、前置条件（测试前必须完成，这是 Agent setup 的手动版）

1. **配置对话源路径**：`alpha-dog.setting.json` 的 `conversation.dir` 当前为空。必须改为 PI 会话目录：`E:/pi-agent/agent/sessions`（用正斜杠）。
2. **重启 MCP 客户端**：让 sidecar 进程起来（当前未运行）。启动后确认进程存在、`engine/state/sidecar.log` 有 `ready` 行。
3. 确认 mcp.json 的 alpha-memory env：`SIDECAR_MODE=wake`、`SIDECAR_NETWORK=on`、`SIDECAR_TICK_SCOPE=tool_call`、`ALPHA_DOG_SETTING` 指向 junction 路径（C:/Users/32203/.mcp/root/Alpha-Memory/alpha-dog.setting.json）。

## 三、测试步骤与预期

### 步骤 1：确认 sidecar 活 + 对话源接上
- 动作：检查进程、读 `engine/state/sidecar.log` 尾部。
- 预期：sidecar 在跑；日志有 `ready server=...`；无报错。
- 记录：实际进程 PID、日志尾部关键行。

### 步骤 2：确认对话源轮次正确
- 动作：读 `engine/state/runtime.json` 的 `conversationState`。
- 预期：`ok=true`、`file` 指向最新 PI 会话 jsonl、`userTurns` = 当前真实对话轮数（应 ≥10）。
- 记录：conversationState 全文。

### 步骤 3：观察 15 档触发（核心）
- 动作：继续正常对话，直到对话源 userTurns 达到 15。盯着 `engine/state/sidecar-wake-history.jsonl` 和 `runtime.json`。
- 预期：**对话轮 15 时立即触发**（不是 16）：wake-history 出现 `lastOp:selfdrive`、`round:15`、`slot:light` 的记录；`runtime.json` 的 round 变成 15。
- 记录：wake-history 新增行全文、触发时间戳。

### 步骤 4：验证 wake 完整执行
- 动作：读 `runtime.json` 的 `lastWake` 与 `lastReport`。
- 预期：`lastWake.slotId='light'`、`round=15`；`model` 有返回（status ok 或 degraded 都记录真实值）；`lastReport.summary.wakes>=1`。
- 记录：lastWake 与 lastReport 全文。

### 步骤 5：验证占位符评估注入
- 动作：读 `runtime.json` 的 `placeholders.slots[15].lastEval`。
- 预期：存在 `mode`（backfill/monitor 之一）、`topicClosed`、`closedAtRound`、`note`；若话题未结束应为 monitor。
- 记录：lastEval 全文。

### 步骤 6：验证状态一致性
- 动作：对比 `runtime.json`（sidecar 写）与 `mcp-control.json`（bridge 写）。
- 预期：`mcp-control.json.running=true`；两个文件不互相覆盖（分工：bridge 写控制态，sidecar 写轮次）。
- 记录：两个文件关键字段。

### 步骤 7：验证幂等（不重复触发）
- 动作：观察对话轮 15 之后、16-20 轮期间 wake-history。
- 预期：15 档只触发一次；16-20 轮无 light 触发记录。
- 记录：16-20 轮期间的 history 行。

## 四、报告格式

每步按：
```
## 步骤 N：<名称>
- 实际结果：<观察到的>
- 通过/失败：<PASS / FAIL>
- 证据：<文件路径 + 关键行/字段>
```

## 五、红线（执行约束）

- 只读状态文件，不手工改 runtime.json / mcp-control.json。
- 不删任何文件；不动 .pi/deeptalk-hooks.json、不动 mcp.json。
- 模型调用会产生 API 费用（network=on），属正常测试成本。
- 若某步失败：记录失败现场（日志/文件快照），**不要擅自"修复"**，把失败报告交回 zyq。
