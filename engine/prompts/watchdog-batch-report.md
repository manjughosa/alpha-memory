# Alpha-Dog 批次统一报告格式

输出一个 JSON 对象：

```json
{
  "round": 210,
  "plans": [],
  "completed": [],
  "failed": [],
  "feedback": [],
  "auditReceipts": [],
  "ok": true
}
```

判定规则：
1. 一次唤醒对应一个 plan，不把多个档口拼成一项。
2. 只有 Alpha 返回结构化节点和审计回执，且看门狗确认一致，才记入 completed。
3. 失败批次保留 batchId，可独立恢复。
4. 报告只汇总结构化状态，不携带模型上下文。
