## v0.3.0 长期稳定版（2026-09）

**npm**: \alpha-memory@0.3.0\（已发布，含 src 源码——修复 git 安装空壳 Issue #2）

> ⚠️ **外部依赖完整Alpha大脑（aeis），请先安装Alpha v0.4.0**（见下方「Alpha大脑」）——本发行包只是 DSH 生态的调用桥，不包含引擎与知识库。

### Alpha大脑（完整Alpha，包运行前提）
从 [CommonTrustProtocol 主仓库](https://github.com/OWNER/CommonTrustProtocol) 获取 `aeis/dist/aeis-0.4.0-py3-none-any.whl`：
```bash
pip install aeis-0.4.0-py3-none-any.whl
```
**v0.4.0 完整自包含单包**（10.2MB）：Alpha核心 + 白箱智慧模块（2846 个 KCCS 注释知识点 + 学科知识库）+ 三入口 + 种子知识（智能论 3.3 + 116 学科卡）——知识库随包分发，装完即用。

### 新能力
- **自迭代闭环（八步）**：感知→识别→分析→验证→固化→记录→反馈→方向性自检；理论完整性自指检查（_theory_integrity）
- **能力工作流化**（仿 ComfyUI）：node{class_type,inputs}+边+拓扑执行+JSON 持久化
- **路由置信度**（DaoTi coherence）、技能条件路由（anthropics/skills + gliding_horse SkillLink）
- **外部感知**：GitHub 高星项目吸纳
- **隐式盲区显式化**：19 处默认值漂移全部声明盲区

### 工具（MCP，共 73 个）
记忆与长期记忆 16 · 推理与认知 15 · 学习与飞轮 12 · 外部摄取 5 · 生命周期 4 · 智慧之书·白箱 7 · 角色扮演 4 · 身体与设备 8 · 服务与安全 2
（工具数按运行时 `_tools()` 实测；`code_compose`/`code_qa` 为白箱内部引擎，经函数注入工作，非 MCP 工具）

### 验证
- 构建 ✅ · 测试 7/7 ✅ · 25 套全回归绿 ✅
- WB-SPEC 白箱代码能力评分 0.9851（W1-W5+W8 满格）

### 安装
```bash
<已废弃：安装路径> web add alpha-memory
# 或 GitHub 安装（本 Release 自带 prebuilt tarball）
<已废弃：安装路径> web add github:OWNER/alpha-memory
```

> 详情见 [README](https://github.com/OWNER/alpha-memory)
