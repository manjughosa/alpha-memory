# 给 Agent 的接入指引

> 这份文件写给**接进来的 Agent**，不是写给人看的教程。人的安装说明在 [`README.md`](README.md)。
> 你要做的是：读环境 → 找配置落点 → 写配置 → 验证通路 → 报告结果。**自己探测，不要问用户「配置文件在哪」。**

## 0. 前置事实

- 推荐入口是 `node runtime/alpha-dog-sidecar.cjs`；sidecar 包裹 `alpha_memory_bridge.js`，由 Node 侧提供 Alpha-Dog 事件源。
- 仅需要裸记忆内核时，入口仍是 `python -m md_cg.mcp_server`。
- 内核**没有任何平台依赖**：它不知道自己在哪个宿主里跑。宿主信息必须由配置注入。
- 路径只认环境变量：`MDCG_ROOT` / `MDCG_DATA_ROOT` / `MDCG_STATE_ROOT` / `ALPHA_MEMORY_HOME` / `MDCG_SESSIONS_ROOT`。
  一个都没配时落到 `~/.alpha-memory`。

## 1. 先确认内核能跑

**下列命令都在仓库的 `engine/` 目录下执行**（内核在 `engine/md_cg/`）。

```bash
cd engine
python md_cg/datapath.py
```

它打印状态根 / 数据根 / 认知图根。报错就先解决 Python 与 `PYTHONPATH`，不要往下走。

再起一次 server，看它答不答：

```bash
cd engine
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' | python -m md_cg.mcp_server
```

期望：返回一段 JSON，`result.serverInfo.name` 为 `mdcg-mcp`，
`result.capabilities` 含 `tools` 与 `resources`。

## 2. 探测宿主的配置落点

**你比任何清单都更清楚自己在哪跑**。按这个顺序探测，命中即用，不要每个都写：

1. **进程环境变量** —— 先看自己继承到的环境，找形如 `<大写名>_HOME` / `<大写名>_CONFIG` /
   `<大写名>_PROFILE` 的变量。它们指向你自己的宿主根目录，是最可靠的线索。
2. **自己从哪启动** —— 看自己的可执行文件路径和当前工作目录，向上回溯到宿主安装目录。
3. **用户目录下的 MCP 配置** —— 在 `~` 下找内容里含 `"mcpServers"` 键的配置，以及这些常见文件名：
   `.mcp.json`、`mcp.json`、`mcp_servers.json`。
4. **项目级配置** —— 当前工作目录及各级父目录下的同名文件。

命中的文件里应该已有、或者可以新增一个 `mcpServers` 配置块。

一个都没命中时：**不要编造路径写进去**。把探测到的环境变量、目录与候选清单列给用户，
让他指定——他比你知道自己的宿主装在哪。

## 3. 写配置

```json
{
  "mcpServers": {
    "alpha-memory": {
      "command": "node",
      "args": ["<Alpha-Memory>/engine/runtime/alpha-dog-sidecar.cjs"],
      "env": {
        "ALPHA_MEMORY_HOME": "<Alpha-Memory>",
        "SIDECAR_MODE": "wake",
        "SIDECAR_NETWORK": "off",
        "MDCG_ROOT": "<记忆目录绝对路径>"
      }
    }
  }
}
```

- `ALPHA_MEMORY_HOME` 必须指向包含根目录 `alpha_memory_bridge.js` 与 `engine/` 的绝对路径；sidecar 会自动包裹 bridge，不要把 command 改成裸 Python。
- **不要手抄路径**：先在 `alpha-dog.setting.json` 的 `sidecar` 块里定好入口，再跑 `npm run mcp:config` 拿现成的 `mcpServers` 块。该命令只读配置，不启动任何进程。
- `SIDECAR_MODE=wake` 才在档口调用 Alpha-Dog runtime；`observe` 只记录；`SIDECAR_NETWORK=off` 是默认本地网络闸。
- `Alpha_Dog_On` 后才开始计数；`Alpha_Dog_Off` 会停止计数并取消待唤醒。
- `MDCG_ROOT` 可以省略，会落到 `~/.alpha-memory/data/mdcg`。**绝不要填包内路径**（包更新会整个替换包目录）。
- 用户的既有记忆在别处时，把那个绝对路径填进 `MDCG_ROOT` 或 `MDCG_STATE_ROOT`，**不要搬动数据**。
- 要写入必须有 `MDCG_TOKEN`；没有令牌时以只读访客运行。令牌由用户签发，**你不要代替他签发**。

## 4. 验证（只有这一步算数）

重启宿主，然后逐项确认：

1. `tools/list` 能看到 Alpha-Dog 控制面；默认先使用 sidecar 配置。
2. 调 `Alpha_Dog_On`，确认返回 `status=on`（未初始化时应返回结构化初始化请求）。
3. 通过主 MCP 会话发出记忆工具调用，确认 `state/sidecar-counter.json` 计数增长。
4. 到达测试档口后，确认 `state/sidecar-wake-signal.json` 有 `source=sidecar`，并检查 `sidecar-wake-history.jsonl` 的最终状态。
5. 调 `Alpha_Dog_Off`，再发记忆工具调用，确认计数不再增长。
6. 已配令牌时再验证写入返回里的 `committed`；没有令牌时确认写入被明确拒绝。

四项全过才算接通。任何一项没过，回到第 3 步改配置，**不要改内核**。

## 5. 报告什么

- 探测到哪个宿主、实际用的是哪个配置文件（绝对路径）
- 写入的配置块原文
- `datapath.py` 打印的状态根与认知图根
- 第 4 步四项的结果，逐项过 / 不过
- 未解决的：原样贴错误，不要改写成「大致正常」

## 6. 不要做的事

- 不要为了接通而改 `md_cg/` 里的代码——内核与宿主解耦是设计约束，不是待办。
- 不要在配置里写相对路径。
- 不要复制、移动或删除用户的既有记忆目录。
- 不要把令牌写进会被提交的文件里。
