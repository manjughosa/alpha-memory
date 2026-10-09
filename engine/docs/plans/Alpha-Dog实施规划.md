# Alpha-Dog 实施规划

> 落盘时间：2026-09-22
> 来源：设计者线下口述，逐字保存，未作任何改写
> 归属：研发侧设计文档（Alpha-Memory）
> 定位：Alpha-Dog 是 API、是智能体、是 LLM，是整个 Alpha 的驾驶舱核心，负责对内部。
> 接口方向：`Alpha_Dog_On` / `Alpha_Dog_Off` 是对外**默认**暴露的两个接口；`CG` / `STG` 是**调试模式**才额外暴露的。

我会分 **8 个步骤**，采用“先建立新链路、再验证、最后切换”的方式。现有 Alpha、`CG`、`STG`、旧看门狗和外部计数链先保留，不直接拆。

## 0. 强制边界：纯 MCP 内核，客户端负责本地化初始化

Alpha-Memory / Alpha-Dog 的交付形态是 **MCP 内核 + MCP 运行时库**。包不是 Alpha 内园的一部分，严禁把 DSH 包、宿主、包入口、包 hooks、挂载逻辑或安装器加入 MCP，也严禁让 Alpha-Dog 依赖某个包才能运行。

本条是实施规划的常驻强制提醒，优先级高于后续实现便利性：

- MCP 只提供 MCP 协议、`Alpha_Dog_On` / `Alpha_Dog_Off`、调度运行时、注册表批处理、反馈闭环、结构化状态和审计回执。
- `round_tick` 等内部能力不得伪装成外部包接口；事件源由发行端使用者的 Agent 或其宿主平台自行提供。
- 首次初始化时，MCP 只能向当前 Agent 展示宿主适配要求、初始化请求和提示词引导；不得替使用者安装包、修改其宿主配置，或把宿主当作 MCP 的运行前置条件。
- 使用者若需要宿主侧自动回合事件，应由使用者在自己的 Agent/宿主平台中完成适配、授权和安装；该适配属于客户端部署结果，不属于 Alpha-Memory 发布物。
- 发行端可以说明客户端初始化步骤，但不得携带、注册、暴露或恢复任何包化 DSH 入口。MCP 脱离包也必须能够完成协议握手、On/Off、状态管理和可验证的运行时调用。
- 任何新增代码、目录、文档或导出，只要引入外部依赖，均视为违反本规划，不得合并。

## 1. 固化协议与目录边界

先定义 Alpha-Dog 的公开接口、内部接口和状态格式。

外部默认只暴露：

```text
Alpha_Dog_On
Alpha_Dog_Off
```

调试模式可额外暴露：

```text
CG
STG
```

内部能力不对外注册：

```text
round_tick
schedule_check
registry_resolve
batch_read
topic_detect
archive_backfill
topic_monitor
memory_propose
memory_feedback
memory_verify
report_create
state_save
```

同时确定目录：

```text
Alpha-Memory/
├── alpha-dog.setting.json
├── model.js
├── prompts/
├── adapters/
├── runtime/
├── state/
└── existing engine/
```

这一阶段只做接口和数据结构，不改变现有运行行为。

**产出：**

```text
接口协议
Setting schema
状态 schema
内部能力目录
目录结构
```

## 2. 建立 Alpha-Dog Setting

实现统一配置加载器，负责：

```text
接口可见性
Alpha-Dog 是否启用
模型配置
档口配置
注册表路径
长期保留策略
首次初始化提醒
宿主适配状态
```

默认配置：

```json
{
  "enabled": false,
  "interfaces": {
    "Alpha_Dog_On": true,
    "Alpha_Dog_Off": true,
    "cg": false,
    "stg": false
  },
  "schedule": {
    "slots": [
      {
        "id": "light",
        "label": "即时落盘",
        "interval": 15,
        "prompt": "watchdog-light",
        "registryTags": ["即时落盘·15轮"],
        "allowedModes": ["backfill", "monitor"]
      },
      {
        "id": "medium",
        "label": "中档巡检",
        "interval": 21,
        "prompt": "watchdog-medium",
        "registryTags": ["系统巡检·21轮"],
        "allowedModes": ["backfill", "monitor"]
      },
      {
        "id": "heavy",
        "label": "重档巡检",
        "interval": 30,
        "prompt": "watchdog-heavy",
        "registryTags": ["记忆巡检·30轮"],
        "allowedModes": [
          "interrupt",
          "fixed_defer",
          "backfill",
          "monitor"
        ]
      }
    ],
    "simultaneousOrder": ["medium", "light", "heavy"],
    "sequentialWake": true
  },
  "registry": {
    "memoryMappingTableMd": "@memory_mapping_table_md",
    "memoryMappingTableJson": "@memory_mapping_table_json"
  },
  "initialization": {
    "mention": "on",
    "status": "unconfigured"
  }
}
```

重点是：`15`、`21`、`30` 只是默认值，调度器读取配置，不把数字写死。

## 3. 完成 Alpha-Dog 初始化流程

首次执行 `Alpha_Dog_On` 时，检查：

```text
是否存在 Setting
是否存在模型配置
API 协议是否可识别
模型是否可访问
模型是否支持文本输入
上下文窗口是否有效
宿主平台是否可识别
注册表路径是否存在
内部状态是否可读写
```

若未初始化，向当前 Agent 展示初始化请求：

```json
{
  "name": "XXX",
  "baseUrl": "",
  "api": "openai-completions",
  "apiKeyRef": "",
  "models": [
    {
      "id": "",
      "reasoning": true,
      "input": ["text"],
      "contextWindow": 1000000,
      "maxTokens": 384000,
      "thinkingLevelMap": {
        "minimal": null,
        "low": null,
        "medium": null
      }
    }
  ]
}
```

这里建议使用：

```text
apiKeyRef
```

而不是把明文 `apiKey` 写进 Setting。

初始化成功后生成：

```text
model.js
adapter.json
init-report.json
```

并执行最小验证：

```text
Node 语法检查
普通文本请求
结构化 JSON 请求
超时处理
错误响应处理
上下文窗口读取
推理等级映射
```

用户拒绝初始化时：

```json
{
  "status": "declined",
  "mention": "off"
}
```

之后不再提醒，但：

```text
Alpha_Dog_On 仍可调用
Alpha_Dog_Off 仍可调用
CG/STG 仍按接口配置工作
看门狗保持 dormant
```

## 4. 加入宿主适配层

根据当前宿主选择适配器：

```text
Claude Code -> .claude
PI          -> .pi
其他 CLI    -> generic adapter
```

适配器只负责把“回合事件”送入 Alpha-Dog，不负责重新实现计数器。

统一事件格式：

```json
{
  "event": "round_tick",
  "sessionId": "session-xxx",
  "round": 42,
  "userInput": "本轮用户输入",
  "timestamp": "2026-..."
}
```

适配层应通过 manifest 管理文件：

```json
{
  "platform": "pi",
  "root": ".pi",
  "event": "UserPromptSubmit",
  "bridge": "alpha_dog_round_event",
  "managedFiles": [
    ".pi/deeptalk-hooks.json"
  ]
}
```

生成或更新适配文件之前，先读取现状、计算差异、保留备份和审计记录。

## 5. 建立 Alpha-Dog 内部运行时

新增几个轻量模块：

```text
runtime/alpha_dog_power.js
runtime/alpha_dog_counter.js
runtime/alpha_dog_scheduler.js
runtime/alpha_dog_wake_queue.js
runtime/alpha_dog_registry.js
runtime/alpha_dog_batcher.js
runtime/alpha_dog_state.js
runtime/alpha_dog_agent.js
```

运行逻辑：

```text
Alpha_Dog_On
  -> 上电
  -> 启动内部计数
  -> 启动调度器
  -> 看门狗保持休眠

普通回合
  -> count + 1
  -> 检查档口
  -> 未到档口则立即结束
  -> 不调用模型

到达档口
  -> 生成 wake plan
  -> 读取注册表
  -> 过滤目标文件
  -> 创建批次
  -> 加载对应说明书
  -> 唤醒看门狗
```

`Alpha_Dog_Off` 执行：

```text
停止计数
停止调度
取消未执行唤醒
保存批次进度
保存监视任务
保存待复核候选
看门狗进入休眠
```

关闭期间不追补轮次。

## 6. 接入三档说明书和连续唤醒

新增：

```text
prompts/watchdog-light.md
prompts/watchdog-medium.md
prompts/watchdog-heavy.md
prompts/watchdog-batch-report.md
```

15 轮说明书只出现：

```text
backfill
monitor
```

21 轮说明书只出现：

```text
backfill
monitor
```

30 轮说明书出现：

```text
interrupt
fixed_defer
backfill
monitor
```

同一轮多个档口同时到期时，建立多个 wake plan，而不是拼成一个超大任务。

默认顺序：

```text
21 -> 15 -> 30
```

每次唤醒：

```text
加载一份说明书
读取一个批次
完成一次判断
保存一次状态
看门狗休眠
```

第 210 轮的行为：

```text
发现 21、15、30 同时到期
  -> 创建三个 wake plan
  -> 第一次唤醒：21
  -> 第二次唤醒：15
  -> 第三次唤醒：30
  -> 生成统一报告
```

三次唤醒之间不共享模型上下文，只共享结构化状态。

## 7. 接入注册表、批处理和 Alpha 反馈

看门狗不读取 85 个文件的全集。

它读取：

```text
@memory_mapping_table_md
@memory_mapping_table_json
```

按当前档口筛选：

```text
15 轮 -> 即时落盘·15轮
21 轮 -> 系统巡检·21轮
30 轮 -> 记忆巡检·30轮
```

然后按优先级和 token 预算分批：

```text
批次 1：高优先级
批次 2：中优先级
批次 3：剩余文件
```

每个批次都保存：

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

记忆闭环：

```text
读取上下文
  -> 看门狗生成候选
  -> Alpha 预检
  -> Alpha 返回 ACCEPT / MERGE / DROP / DEFER / CONFLICT
  -> 看门狗解释反馈
  -> 修改、重提、复核或结束
  -> Alpha 执行写入
  -> 返回节点和审计回执
  -> 看门狗确认结果
```

这一步是本次升级的核心。没有反馈闭环，Alpha-Dog 仍然只是“更方便的投递器”。

## 8. Shadow 验证和正式切换

不会直接切断旧链。

设置三种运行模式：

```text
legacy
  旧 record -> 旧 watchdog -> Alpha

shadow
  新 Alpha-Dog 运行，但只生成报告和差异，不正式写入

alpha_dog
  Alpha-Dog 成为正式执行链
```

验证顺序：

```text
1. 旧链保持工作。
2. 新链读取相同输入。
3. 比较旧链和新链的轮次、候选、档口、反馈。
4. 新链只写临时状态和审计路径。
5. 通过后切换正式写入。
6. 最后再决定是否停用旧链。
```

重点验证：

```text
Alpha_Dog_On 是否只上电、不立即唤醒。
Alpha_Dog_Off 是否完全停止计数和唤醒。
普通轮次是否零模型调用。
15/21 是否看不到 interrupt 和 fixed_defer。
30 是否拥有四种模式。
210 是否连续三次唤醒。
85 个文件是否按注册表和批次处理。
Alpha 反馈是否回到看门狗。
失败批次是否可以单独恢复。
重复事件是否不会重复写入。
```

## 执行顺序

实际动手时，我会按这个顺序推进：

```text
第一阶段：协议、Setting、状态 schema
第二阶段：初始化和 model.js 适配
第三阶段：宿主适配器
第四阶段：内部计数、调度和唤醒队列
第五阶段：三档提示词和注册表批处理
第六阶段：Alpha 反馈闭环
第七阶段：shadow 验证
第八阶段：alpha_dog 正式切换
```

可以并行的部分：

```text
Setting schema 与初始化流程
宿主 adapter contract 与内部状态 schema
三档提示词与注册表筛选器
```

必须串行的部分：

```text
协议确定
  -> 运行时接入
  -> 反馈闭环
  -> shadow 验证
  -> 正式切换
```

## 我会坚持的工程标准

```text
不在第一步修改旧链。
不把提示词当作状态一致性的唯一保障。
不把 85 个文件一次性送入模型。
不让普通回合调用 API。
不让 15/21 获得 30 轮权限。
不让 Alpha_Dog_Off 只停模型而继续计数。
不把明文 API key 写入公开配置。
不在没有结构化回执的情况下宣布写入成功。
不在 shadow 验证前切正式链。
```

最终完成后的行为是：

```text
Alpha_Dog_On
  -> Alpha-Dog 上电
  -> 内部计数开始
  -> 看门狗休眠

15 / 21 / 30 到期
  -> 对应锤子敲醒看门狗
  -> 加载对应说明书
  -> 按注册表筛选并分批处理
  -> 读取 Alpha 反馈
  -> 看门狗复核
  -> 保存报告
  -> 休眠

Alpha_Dog_Off
  -> 整体断电
  -> 停止计数
  -> 停止调度
  -> 停止唤醒
  -> 停止模型调用
```

这是最快的高质量路径：新增运行时，不破坏现有 Alpha；先让阿尔法狗在旁边完整跑通，再把正式控制权交给它。
