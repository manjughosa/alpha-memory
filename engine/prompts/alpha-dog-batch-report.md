# Alpha-Dog 批次统一报告格式（参考）

本说明书定义 Alpha-Dog 一轮唤醒后的统一报告结构。报告由运行时生成，本文件供看门狗理解"一次唤醒产出什么"，不参与生成。

## 结构（与运行时 `lastReport` 对齐）

```json
{
  "kind": "report",
  "round": 15,
  "prompt": "engine/prompts/alpha-dog-batch-report.md",
  "summary": {
    "wakes": 1,
    "completed": 1,
    "degraded": 0,
    "batches": ["light-15-01"]
  },
  "wakes": [
    {
      "slot": 15,
      "slotId": "light",
      "round": 15,
      "mode": "backfill",
      "topicClosed": true,
      "closedAtRound": 12,
      "model": { "status": "ok" },
      "degraded": false,
      "feedback": []
    }
  ]
}
```

## 判定规则
1. 一次唤醒对应一个 wake；多个档口同时到期时每个档口一个 wake，不拼成一项。
2. `summary.completed` = 非 degraded 的 wake 数；`degraded` = 模型调用失败的 wake 数（记入治理欠账，绝不当作成功）。
3. 失败批次保留 `batchId`，可独立恢复（`recoverFailedBatches`）。
4. 报告只汇总结构化状态，不携带模型上下文。
