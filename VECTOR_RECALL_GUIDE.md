# Alpha Memory 向量召回使用与验收边界

更新：2026-10-10 修复。此前“完整生产就绪”和 50 倍提速等表述没有对应生产端到端证据，本指南不沿用这些结论。

## 默认行为与依赖

- 默认 `MDCG_VECTOR_AUTO_INDEX=0`：普通记忆写入不调用 Ollama，不等待模型服务。
- 需要自动向量化时显式设置 `MDCG_VECTOR_AUTO_INDEX=1`，然后重启桥接进程。自动索引是同步可选操作，模型超时仍可能拖慢该次写入；主记忆写入与向量索引成败分开。
- 模型：本地 Ollama `qwen3-embedding:0.6b`，1024 维，接口 `http://127.0.0.1:11434/v1/embeddings`。仅接受 loopback 地址，禁用环境代理与 HTTP 重定向。
- Qdrant：`qdrant-client==1.19.1`，在**桥接实际使用的 Python** 中安装 `engine/requirements.txt`。项目自带 `runtime/python.exe` 已可导入；系统 Python 是另一套环境。
- 向量存放在 `<root>/qdrant/`，不是 Markdown 主存储的替代品。

## MCP 调用

工具名是 `mdcg_recall`，`vector` 参数已声明在 inputSchema 中。`vector: true` 会追加向量通路，不会自动删除默认召回通路。

```json
{"query":"红狐狸住在哪里？","vector":true}
```

依照现有调用返回层读取召回 metadata；向量通路失败会有 `vector_error`，不能把失败当成“没有相关记忆”。

## Python 调用

```python
from md_cg.mdcos import MdCGSecure
from md_cg.security import Principal

principal = Principal(tenant="example", actor="owner", clearance="public", can_write=True)
md = MdCGSecure(root="YOUR_MEMORY_ROOT", principal=principal)
md.add("example", "A red fox lives beside a quiet lake.", sensitivity="public")
# add 仅在 MDCG_VECTOR_AUTO_INDEX=1 时自动向量化。
results, meta = md.search_rrf("Where does the red fox live?", paths=("vector",), judge=False)
print(meta.get("vector_error"))
```

使用真实租户与身份，不为演示改变既有权限。直接使用底层 `VectorIndex.search()` 不提供完整 Alpha 权限边界；生产召回应通过 `MdCGSecure` / MCP。

## 桥接令牌文件

- `MDCG_TOKEN`：明文 bearer，优先于 bearer 文件。
- `MDCG_TOKEN_REGISTRY_FILE`：JSON 令牌注册表路径；桥接转为 Python 的 `MDCG_TOKEN_FILE`。
- `MDCG_BEARER_TOKEN_FILE`：明文 bearer 文件路径，与 JSON 注册表分开。
- 兼容历史 `MDCG_TOKEN_FILE`：JSON 内容按注册表传入 Python；纯文本按 bearer 读取，不再误当注册表。历史 bearer 文件可配合 `MDCG_TOKEN_REGISTRY_FILE` 使用。

## 存量迁移

修复过程中**没有执行正式记忆迁移**。以下命令是手动入口，不是初始化必跑步骤：

```text
cd "engine"
..\runtime\python.exe -X utf8 -m md_cg.migrate_to_vector "YOUR_MEMORY_ROOT" --batch-size 100
```

默认跳过 private/secret，按当前 Markdown 源文件读取内容，不取索引里缺失或过期的正文。`--include-private` 是显式敏感派生数据选项：底层迁移读取器不是完整安全解密入口，不把此选项当作安全私有明文召回的保证。增量迁移、全库孤儿点清理和敏感数据迁移未验收。

## 修复后的保证与边界

- SHA-256 派生稳定 point ID；重新索引/删除按 `node_id` payload 清理历史随机 hash ID。
- 通过操作级 OS 文件锁串行访问嵌入式 Qdrant，每次操作打开并关闭 client；已测试同库双进程，不采用永久占锁单例。
- 在 top-k 之前限定当前已授权候选 ID，随后再核对命中并读回 Markdown；tenant、clearance、session、validity 仍由现有安全候选流程决定。
- `_write_node` 成功后清理旧向量；开启自动索引时 public/internal 重建，转 private/secret 删旧向量。forget 重启后也能删除向量。
- 向量故障通过 `vector_error` / secure health `vector.last_error` 可见；索引底层失败另有日志。向量召回绕过缓存，避免故障被缓存为空命中；成功重试后清除健康错误。
- 旧库里从前遗留的孤儿点没有被全量清扫；未被授权且不存在的 ID 不应进入安全召回。正式库恢复与重建需另行执行，不把临时库测试当作正式库数据验收。
- 维度必须为 1024；同维度切换模型仍需人工重建索引，本次没有实施模型版本迁移协议。
- 没有重新跑 10k/300 生产端到端性能门槛；历史内存模式 benchmark 数字不等于生产延迟。

## 回归命令

从 `engine` 使用实际桥接 Python：

```text
..\runtime\python.exe -X utf8 -m md_cg.test_vector_production
..\runtime\python.exe -X utf8 -m md_cg.test_synthetic_vector_recall
..\runtime\python.exe -X utf8 scripts/run_tests.py md_cg
npm run build
npm test
npm run doctor
npm pack --dry-run --json
```

生产向量回归覆盖重启 ID、历史重复点清理、双进程、top-k 前权限限制、敏感度转换、更新、忘记、默认不调用模型、故障可见和迁移源读回。所有回归使用合成临时库。
