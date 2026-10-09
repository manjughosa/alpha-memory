"""Deterministic synthetic recall fixtures and ranking metrics."""
from __future__ import annotations

import hashlib
import json
import random
from collections import defaultdict
from typing import Any, Iterable, Mapping, Sequence

LAYERS = ("anchor", "structural", "knowledge", "contextual", "self")
SENSITIVITIES = ("public", "internal", "private", "secret")
Q_TYPES = ("prefix_240", "late_240", "zh_2", "zh_3plus", "mixed", "paraphrase")
_ZH_2 = ("青山", "白云", "雨伞", "纸鸢", "星河", "晚风", "晨露", "古桥", "新芽", "竹影", "山茶", "海盐", "灯塔", "木舟", "石阶", "花窗", "雪松", "溪流", "田野", "秋叶", "春笋", "麦田", "松果", "月光", "潮汐", "云杉", "湖畔", "风铃", "苔藓", "野菊")
_ZH_LONG = ("数据保留策略", "缓存淘汰窗口", "异步任务队列", "跨区复制状态", "索引重建计划", "请求限流阈值", "会话续期规则", "分片迁移进度", "密钥轮换周期", "审计日志格式", "冷启动优化项", "批处理提交量", "备份校验结果", "故障恢复步骤", "写入确认条件", "查询超时配置", "向量归一方式", "访问隔离范围", "事件去重规则", "模型调用边界", "源文件定位键", "过期节点处理", "排序融合权重", "稀疏索引字段", "回滚验收标准", "并发写入限制", "增量摄取游标", "召回证据编号", "权限审查记录", "合成样本标签")
_MIXED = (("cache refresh", "缓存刷新"), ("retry budget", "重试预算"), ("sparse index", "稀疏索引"), ("tenant scope", "租户范围"), ("query timeout", "查询超时"), ("write watermark", "写入水位"), ("token budget", "token 预算"), ("source locator", "来源定位"), ("rank fusion", "排序融合"), ("vector dimension", "向量维度"), ("access policy", "访问策略"), ("event cursor", "事件游标"), ("cold start", "冷启动"), ("batch size", "批处理大小"), ("dedupe key", "去重键"), ("tenant filter", "租户过滤"), ("payload schema", "载荷结构"), ("score threshold", "分数阈值"), ("index rebuild", "索引重建"), ("source hash", "来源哈希"), ("retry delay", "重试延迟"), ("search route", "检索路由"), ("permission check", "权限检查"), ("shard key", "分片键"), ("snapshot id", "快照编号"), ("merge window", "合并窗口"), ("recall cutoff", "召回截点"), ("model endpoint", "模型端点"), ("failure reason", "失败原因"), ("consistency check", "一致性检查"))
_PARAPHRASE = (
    ("The cache entry expires after 45 seconds.", "When does the cache entry expire?"),
    ("The worker retries a failed request twice.", "How many retries follow a failed request?"),
    ("The archive keeps three independent copies.", "How many copies does the archive keep?"),
    ("The queue accepts batches of 64 events.", "How many events do queue batches accept?"),
    ("The session remains valid for 30 minutes.", "How long is the session valid?"),
    ("The index rebuild runs every Sunday.", "When does the index rebuild run?"),
    ("The service caps requests at 120 per minute.", "How many requests can the service cap each minute?"),
    ("The timeout for search is 800 milliseconds.", "What is the search timeout?"),
    ("The backup check records a SHA-256 digest.", "What digest does the backup check record?"),
    ("The tenant boundary is enforced before ranking.", "When is the tenant boundary enforced?"),
    ("The batch writer commits after 500 records.", "When does the batch writer commit?"),
    ("The source cursor advances only after success.", "When does the source cursor advance?"),
    ("The sparse index stores term frequencies.", "What frequencies does the sparse index store?"),
    ("The encryption key rotates every 90 days.", "When does the encryption key rotate?"),
    ("The recall response is limited to 4096 tokens.", "What token limit applies to the recall response?"),
    ("夜间备份窗口从周五开始。", "On which weekday does the nightly archive window open?"),
    ("任务队列最多等待八分钟。", "What is the upper bound for pending work duration?"),
    ("权限变更会写入审计记录。", "Where is the change of access rights logged?"),
    ("新索引采用分批重建方式。", "How is the replacement search structure rebuilt?"),
    ("检索失败时保留原始来源标识。", "Which reference remains available after a lookup error?"),
    ("写入事件以租户编号隔离。", "What identifier separates each customer workspace?"),
    ("超时请求最多额外尝试三次。", "How many additional attempts follow a time limit?"),
    ("事件摘要保留完整中文字符。", "What encoding must the short description preserve?"),
    ("来源文件路径随证据一同返回。", "How can a returned result be traced to its document?"),
    ("召回列表按融合分数排序。", "Which value determines the order of retrieved items?"),
    ("合成评测固定随机种子为 42。", "What setting makes the generated evaluation reproducible?"),
    ("内存条目预算按估算 token 计量。", "What unit controls the maximum returned context size?"),
    ("权限过滤必须先于结果打包。", "At which stage must authorization happen?"),
    ("摄取游标保存在独立状态文件。", "Where does the import process resume its previous position?"),
    ("向量检索关闭时仍执行词面搜索。", "Which fallback can operate without embeddings?"),
)


def _digest(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _target(qtype: str, number: int) -> tuple[str, str, bool | None]:
    if qtype == "prefix_240":
        text = f"合成会议记录：{_ZH_LONG[number]}的负责人确认采用第{number + 1}号方案。"
        return text, text[:48], None
    if qtype == "late_240":
        prefix = "合成背景记录；本段仅用于固定前缀截断测试。" * 18
        text = prefix + chr(10) + f"关键结论：{_LATE_TERMS[number]}对应测试编号{number + 1}。"
        return text, f"{_LATE_TERMS[number]}对应哪个测试编号？", None
    if qtype == "zh_2":
        return f"合成记录编号{number + 1}涉及{_ZH_2[number]}的状态核验。", _ZH_2[number], None
    if qtype == "zh_3plus":
        return f"合成记录编号{number + 1}：{_ZH_3_TERMS[number]}已完成只读检查。", _ZH_3_TERMS[number], None
    if qtype == "mixed":
        english, chinese = _MIXED[number]
        return f"Synthetic note {number + 1}: {english} 对应 {chinese} 的检查结果已记录。", f"{english} 的{chinese}记录在哪里？", None
    if qtype == "paraphrase":
        text, query = _PARAPHRASE[number]
        return text, query, number < 15
    raise ValueError(f"unsupported question type: {qtype}")


def build_fixture(seed: int = 20261009) -> dict[str, Any]:
    """Build exactly 1,000 synthetic events and 180 evidence-linked questions."""
    rng = random.Random(seed)
    events: list[dict[str, Any]] = []
    questions: list[dict[str, Any]] = []
    for qtype in Q_TYPES:
        for number in range(30):
            content, query, overlap = _target(qtype, number)
            event_id = f"synthetic_event_{len(events):04d}"
            events.append({"id": event_id, "content": content,
                           "layer": LAYERS[len(events) % len(LAYERS)],
                           "sensitivity": SENSITIVITIES[len(events) % len(SENSITIVITIES)],
                           "source": "synthetic_fixture"})
            questions.append({"id": f"synthetic_question_{len(questions):04d}",
                              "qtype": qtype, "query": query,
                              "evidence_ids": [event_id], "lexical_overlap": overlap})
    for number in range(820):
        event_id = f"synthetic_event_{len(events):04d}"
        events.append({"id": event_id,
                       "content": f"合成背景事件{number:04d}：例行状态巡检完成，结果已记录；不包含真实人员、账号或业务数据。",
                       "layer": LAYERS[len(events) % len(LAYERS)],
                       "sensitivity": SENSITIVITIES[len(events) % len(SENSITIVITIES)],
                       "source": "synthetic_fixture"})
    rng.shuffle(events)
    rng.shuffle(questions)
    manifest = {"seed": seed, "event_count": len(events), "question_count": len(questions),
                "events_sha256": _digest(events), "questions_sha256": _digest(questions)}
    return {"events": events, "questions": questions, "manifest": manifest}


def _summarize(rows: Sequence[Mapping[str, Any]], k_values: Sequence[int]) -> dict[str, Any]:
    ranks = [row.get("rank") for row in rows]
    recall = {str(k): sum(rank is not None and 0 < rank <= k for rank in ranks) / len(rows) if rows else 0.0
              for k in k_values}
    reciprocal = [(1.0 / rank) if rank is not None and 0 < rank <= 10 else 0.0 for rank in ranks]
    hits5 = sum(rank is not None and 0 < rank <= 5 for rank in ranks)
    return {"n": len(rows), "recall_at": recall,
            "mrr_at_10": sum(reciprocal) / len(rows) if rows else 0.0,
            "precision_at_5": hits5 / (5 * len(rows)) if rows else 0.0}


def summarize_rankings(rows: Iterable[Mapping[str, Any]],
                       k_values: Sequence[int] = (1, 5, 10)) -> dict[str, Any]:
    """Summarize one-gold-evidence rankings overall and by question category."""
    materialized = list(rows)
    if any(not isinstance(k, int) or isinstance(k, bool) or k <= 0 for k in k_values):
        raise ValueError("k_values must contain positive integers")
    by_qtype: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in materialized:
        qtype = row.get("qtype")
        if not isinstance(qtype, str) or not qtype:
            raise ValueError("every ranking row must have a non-empty qtype")
        rank = row.get("rank")
        if rank is not None and (not isinstance(rank, int) or isinstance(rank, bool) or rank < 0):
            raise ValueError("rank must be a positive one-based integer, 0, or None for a miss")
        by_qtype[qtype].append(row)
    paraphrase_rows = [row for row in materialized if row["qtype"] == "paraphrase"]
    overlap_groups = {
        "overlap": [row for row in paraphrase_rows if row.get("lexical_overlap") is True],
        "no_overlap": [row for row in paraphrase_rows if row.get("lexical_overlap") is False],
    }
    return {
        **_summarize(materialized, k_values),
        "by_qtype": {qtype: _summarize(group, k_values)
                     for qtype, group in sorted(by_qtype.items())},
        "by_paraphrase_overlap": {
            label: _summarize(group, k_values)
            for label, group in overlap_groups.items()
        },
    }


def evaluate_questions(cg: Any, questions: Iterable[Mapping[str, Any]], *,
                       k: int = 50, budget_tokens: int = 8192,
                       judge: bool = False,
                       max_item_tokens: int | None = None,
                       paths: Sequence[str] | None = None) -> dict[str, Any]:
    """Run fixed, model-free recall calls against an already isolated synthetic CG."""
    from math import ceil
    from time import perf_counter

    rows = []
    latencies = []
    for question in questions:
        started = perf_counter()
        kwargs: dict[str, Any] = {
            "budget_tokens": budget_tokens,
            "k": k,
            "judge": judge,
        }
        if max_item_tokens is not None:
            kwargs["max_item_tokens"] = max_item_tokens
        if paths is not None:
            kwargs["paths"] = tuple(paths)
        response = cg.recall(question["query"], **kwargs)
        elapsed_ms = (perf_counter() - started) * 1000
        pack = response["pack"]
        if not isinstance(pack, list):
            raise TypeError("recall response pack must be a list")
        retrieved_ids = [entry["id"] for entry in pack]
        evidence_ids = set(question["evidence_ids"])
        rank = next((index for index, node_id in enumerate(retrieved_ids, 1)
                     if node_id in evidence_ids), 0)
        rows.append({
            "qid": question["id"],
            "qtype": question["qtype"],
            "lexical_overlap": question.get("lexical_overlap"),
            "rank": rank,
            "retrieved_ids": retrieved_ids,
            "latency_ms": elapsed_ms,
            "truncated_items": sum(bool(entry.get("truncated")) for entry in pack),
            "skipped_items": len(response["skipped"]),
        })
        latencies.append(elapsed_ms)

    ordered = sorted(latencies)
    def percentile(p: float) -> float:
        if not ordered:
            return 0.0
        return ordered[max(0, ceil(p * len(ordered)) - 1)]

    return {
        "rows": rows,
        "summary": summarize_rankings(rows),
        "latency_ms": {"p50": percentile(0.50), "p95": percentile(0.95)},
        "counts": {
            "misses": sum(row["rank"] == 0 for row in rows),
            "rank_after_10": sum(row["rank"] > 10 for row in rows),
            "truncated_items": sum(row["truncated_items"] for row in rows),
            "skipped_items": sum(row["skipped_items"] for row in rows),
        },
    }


def run_baseline(fixture: Mapping[str, Any] | None = None, *,
                 seed: int = 20261009, k: int = 50, budget_tokens: int = 8192,
                 judge: bool = False, max_item_tokens: int | None = None,
                 paths: Sequence[str] | None = None) -> dict[str, Any]:
    """Build and evaluate a disposable, encrypted-capable, synthetic-only store.

    The high-clearance principal and deterministic ephemeral key are confined to
    this temporary root. No configured Alpha data path or external key is read.
    """
    from tempfile import TemporaryDirectory

    from .mdcos import DEFAULT_MAX_ITEM_TOKENS, MdCGSecure
    from .security import Principal

    fixture = build_fixture(seed=seed) if fixture is None else fixture
    ephemeral_key = hashlib.sha256(b"alpha-memory-synthetic-benchmark-only").digest()
    principal = Principal(
        tenant="synthetic-benchmark",
        actor="synthetic-benchmark",
        clearance="secret",
        session="synthetic-benchmark",
    )
    with TemporaryDirectory(prefix="alpha-memory-synthetic-") as root:
        cg = MdCGSecure(root, principal=principal, master_key=ephemeral_key)
        for event in fixture["events"]:
            cg.add(
                event["id"],
                event["content"],
                layer=event["layer"],
                sensitivity=event["sensitivity"],
                tags=["synthetic_benchmark"],
                importance=0.1,
                confidence=1.0,
            )
        report = evaluate_questions(
            cg,
            fixture["questions"],
            k=k,
            budget_tokens=budget_tokens,
            judge=judge,
            max_item_tokens=max_item_tokens,
            paths=paths,
        )
    report["manifest"] = fixture["manifest"]
    report["parameters"] = {
        "k": k,
        "budget_tokens": budget_tokens,
        "judge": judge,
        "max_item_tokens": (max_item_tokens if max_item_tokens is not None
                             else DEFAULT_MAX_ITEM_TOKENS),
        "paths": list(paths) if paths is not None else "engine_default",
        "root_mode": "temporary_synthetic_only",
    }
    return report

def run_source_ingested(fixture: Mapping[str, Any] | None = None, *,
                        seed: int = 20261009, k: int = 50,
                        budget_tokens: int = 8192, judge: bool = False,
                        max_item_tokens: int | None = None,
                        paths: Sequence[str] | None = None) -> dict[str, Any]:
    """Evaluate the real source-ingest and authoritative-recall path on synthetic data."""
    import os
    from tempfile import TemporaryDirectory
    from unittest.mock import patch

    from .mdcos import MdCGSecure
    from .security import Principal
    from .sources import Ingestor, JsonlSource

    fixture = build_fixture(seed=seed) if fixture is None else fixture
    events = fixture["events"]
    ephemeral_key = hashlib.sha256(b"alpha-memory-synthetic-benchmark-only").digest()
    principal = Principal(
        tenant="synthetic-benchmark", actor="synthetic-benchmark",
        clearance="secret", session="synthetic-benchmark",
    )
    with TemporaryDirectory(prefix="alpha-memory-source-benchmark-") as root:
        source_root = os.path.join(root, "sources")
        os.makedirs(source_root)
        source_path = os.path.join(source_root, "events.jsonl")
        with open(source_path, "w", encoding="utf-8") as stream:
            for seq, event in enumerate(events, 1):
                content = event.get("content")
                if not isinstance(content, str) or not content:
                    raise ValueError("every synthetic source event must have non-empty content")
                stream.write(json.dumps({
                    "seq": seq, "session": "synthetic-source-benchmark",
                    "text": content,
                }, ensure_ascii=False) + "\n")

        with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
            cg = MdCGSecure(os.path.join(root, "memory"), principal=principal,
                            master_key=ephemeral_key, autoflush=1)
            ingested = Ingestor(cg).ingest(JsonlSource(source_path),
                                           mine_fix_pairs=False)
            if ingested["denied"] or ingested["written"] != len(events):
                raise RuntimeError(f"synthetic source ingest incomplete: {ingested}")

            id_by_event = {
                event["id"]: node_id for event, node_id in zip(events, ingested["ids"])
            }
            questions = []
            for question in fixture["questions"]:
                translated = dict(question)
                try:
                    translated["evidence_ids"] = [
                        id_by_event[event_id] for event_id in question["evidence_ids"]
                    ]
                except KeyError as exc:
                    raise ValueError(f"question references unknown event: {exc.args[0]}") from exc
                questions.append(translated)
            report = evaluate_questions(
                cg, questions, k=k, budget_tokens=budget_tokens, judge=judge,
                max_item_tokens=max_item_tokens, paths=paths,
            )

    report["manifest"] = fixture.get("manifest", {})
    report["source_ingest"] = {
        "new_events": ingested["new_events"],
        "written": ingested["written"],
        "denied": ingested["denied"],
    }
    report["parameters"] = {
        "k": k, "budget_tokens": budget_tokens, "judge": judge,
        "max_item_tokens": max_item_tokens,
        "paths": list(paths) if paths is not None else "engine_default",
        "root_mode": "temporary_synthetic_source_only",
    }
    return report
_LATE_TERMS = ("归档取回流程", "周报提交时限", "队列积压上限", "副本校验频率", "密文解封路径", "凭证过期时刻", "审批记录编号", "重试退避间隔", "冷热分层规则", "异常恢复窗口", "配额重置日期", "事件保留期限", "巡检完成条件", "分区合并周期", "游标确认方式", "请求撤销策略", "任务租约时长", "备份恢复目标", "延迟告警界限", "数据清理步骤", "冲突裁决原则", "持久化确认点", "会话归属规则", "并行消费数量", "源记录版本号", "索引切换顺序", "滞后检测阈值", "临时文件期限", "访问令牌范围", "失败队列名称")
_ZH_3_TERMS = ("螺旋桨", "山谷回声", "松针气味", "瓷器纹样", "潮湿岩壁", "铜钟余音", "织布纹理", "纸张厚度", "草木清香", "玻璃折射", "石英晶体", "蜂群路径", "羽毛色泽", "灯芯长度", "河床沉积", "屋檐滴水", "织机转速", "海鸟迁徙", "果实成熟", "溪谷温度", "木纹走向", "苔原植被", "瀑布落差", "麦穗含水", "沙丘移动", "云层高度", "珊瑚生长", "钟表误差", "盐晶形状", "陶土配方")


def _request_local_embeddings(texts: Sequence[str], *, model: str, base_url: str,
                              timeout_seconds: float) -> list[list[float]]:
    from urllib.parse import urlsplit
    from urllib.request import Request, urlopen

    parsed = urlsplit(base_url)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.path.rstrip("/") != "/v1" or parsed.username or parsed.password
            or parsed.query or parsed.fragment):
        raise ValueError("embedding base_url must be a local HTTP /v1 endpoint")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    endpoint = base_url.rstrip("/") + "/embeddings"
    payload = json.dumps({"model": model, "input": list(texts)},
                         ensure_ascii=False).encode("utf-8")
    request = Request(endpoint, data=payload,
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=timeout_seconds) as response:
        result = json.load(response)
    if result.get("model") != model:
        raise RuntimeError(f"unexpected embedding model: {result.get('model')!r}")
    data = result.get("data")
    if not isinstance(data, list) or len(data) != len(texts):
        raise RuntimeError("embedding response count mismatch")
    if any(not isinstance(item, dict) for item in data):
        raise RuntimeError("embedding response item must be an object")
    indices = [item.get("index") for item in data]
    if any(not isinstance(index, int) or isinstance(index, bool) for index in indices):
        raise RuntimeError("embedding response has invalid item indices")
    if sorted(indices) != list(range(len(texts))):
        raise RuntimeError("embedding response indices are missing or duplicated")
    data.sort(key=lambda item: item["index"])
    vectors = [item.get("embedding") for item in data]
    if any(not isinstance(vector, list) or not vector for vector in vectors):
        raise RuntimeError("embedding response contains a missing or empty vector")
    dimensions = len(vectors[0])
    if any(len(vector) != dimensions for vector in vectors):
        raise RuntimeError("embedding dimensions are inconsistent")
    return vectors


def run_local_embedding_recall(fixture: Mapping[str, Any] | None = None, *,
                               seed: int = 20261009,
                               model: str = "qwen3-embedding:0.6b",
                               base_url: str = "http://127.0.0.1:11434/v1",
                               batch_size: int = 32,
                               timeout_seconds: float = 120.0,
                               embedding_fn: Any = None) -> dict[str, Any]:
    """Evaluate full synthetic events with loopback-only dense embeddings in memory."""
    from math import ceil, isfinite, sqrt
    from time import perf_counter

    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size <= 0:
        raise ValueError("batch_size must be a positive integer")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("model must be a non-empty string")
    fixture = build_fixture(seed=seed) if fixture is None else fixture
    events = fixture["events"]
    questions = fixture["questions"]
    if not events:
        raise ValueError("synthetic embedding benchmark requires at least one event")
    event_ids = [event.get("id") for event in events]
    if any(not isinstance(event_id, str) or not event_id for event_id in event_ids):
        raise ValueError("every synthetic event must have a non-empty id")
    if len(set(event_ids)) != len(event_ids):
        raise ValueError("synthetic event ids must be unique")
    documents = [event.get("content") for event in events]
    if any(not isinstance(text, str) or not text for text in documents):
        raise ValueError("every synthetic event must have non-empty content")
    if embedding_fn is None:
        embed = lambda texts: _request_local_embeddings(
            texts, model=model, base_url=base_url,
            timeout_seconds=timeout_seconds,
        )
    elif callable(embedding_fn):
        embed = embedding_fn
    else:
        raise TypeError("embedding_fn must be callable")

    def unit_vector(vector: Any) -> list[float]:
        if not isinstance(vector, (list, tuple)) or not vector:
            raise RuntimeError("embedding vector must be a non-empty list")
        values = [float(value) for value in vector]
        if any(not isfinite(value) for value in values):
            raise RuntimeError("embedding vector contains a non-finite value")
        norm = sqrt(sum(value * value for value in values))
        if norm == 0:
            raise RuntimeError("embedding vector has zero magnitude")
        return [value / norm for value in values]

    def embed_many(texts: Sequence[str]) -> list[list[float]]:
        vectors = []
        for offset in range(0, len(texts), batch_size):
            batch = list(texts[offset:offset + batch_size])
            response = embed(batch)
            if not isinstance(response, (list, tuple)) or len(response) != len(batch):
                raise RuntimeError("embedding provider returned an unexpected vector count")
            vectors.extend(unit_vector(vector) for vector in response)
        return vectors

    index_started = perf_counter()
    document_vectors = embed_many(documents)
    dimensions = len(document_vectors[0])
    if any(len(vector) != dimensions for vector in document_vectors):
        raise RuntimeError("document embedding dimensions are inconsistent")
    index_build_ms = (perf_counter() - index_started) * 1000
    positions = {event_id: index for index, event_id in enumerate(event_ids)}
    rows = []
    latencies = []
    instruction = "Instruct: Retrieve the most relevant memory event that answers the user's query."
    for question in questions:
        query = question.get("query")
        evidence_ids = question.get("evidence_ids")
        if not isinstance(query, str) or not query:
            raise ValueError("every synthetic query must be non-empty")
        if not isinstance(evidence_ids, list) or not evidence_ids:
            raise ValueError("every synthetic query must include evidence ids")
        try:
            evidence_positions = {positions[event_id] for event_id in evidence_ids}
        except KeyError as exc:
            raise ValueError(f"question references unknown event: {exc.args[0]}") from exc
        query_text = instruction + chr(10) + "Query: " + query
        started = perf_counter()
        query_vector = embed_many([query_text])[0]
        if len(query_vector) != dimensions:
            raise RuntimeError("query and document embedding dimensions differ")
        scores = [sum(a * b for a, b in zip(query_vector, vector))
                  for vector in document_vectors]
        ranked = sorted(range(len(events)),
                        key=lambda index: (-scores[index], event_ids[index]))
        rank = next((index for index, candidate in enumerate(ranked, 1)
                     if candidate in evidence_positions), 0)
        elapsed_ms = (perf_counter() - started) * 1000
        latencies.append(elapsed_ms)
        rows.append({
            "qid": question.get("id"),
            "qtype": question.get("qtype"),
            "lexical_overlap": question.get("lexical_overlap"),
            "rank": rank,
            "retrieved_ids": [event_ids[index] for index in ranked[:10]],
            "latency_ms": elapsed_ms,
        })

    ordered = sorted(latencies)
    def percentile(p: float) -> float:
        if not ordered:
            return 0.0
        return ordered[max(0, ceil(p * len(ordered)) - 1)]

    return {
        "rows": rows,
        "summary": summarize_rankings(rows, k_values=(1, 5, 10)),
        "latency_ms": {
            "index_build": index_build_ms,
            "p50": percentile(0.50),
            "p95": percentile(0.95),
        },
        "counts": {
            "misses": sum(row["rank"] == 0 for row in rows),
            "rank_after_10": sum(row["rank"] > 10 for row in rows),
        },
        "manifest": fixture.get("manifest", {}),
        "parameters": {
            "model": model,
            "dimensions": dimensions,
            "batch_size": batch_size,
            "query_instruction": instruction,
            "document_text": "full_synthetic_source_event",
            "storage": "in_memory",
            "data_scope": "synthetic_only",
        },
    }


def build_stress_fixture(seed: int = 20261009, *, event_count: int = 10000,
                         question_count: int = 300) -> dict[str, Any]:
    """Extend the fixed benchmark with unique synthetic distractors and repeat queries."""
    if (not isinstance(event_count, int) or isinstance(event_count, bool)
            or event_count < 1000):
        raise ValueError("event_count must be an integer of at least 1000")
    if (not isinstance(question_count, int) or isinstance(question_count, bool)
            or question_count < 180):
        raise ValueError("question_count must be an integer of at least 180")

    fixture = build_fixture(seed=seed)
    events = list(fixture["events"])
    questions = list(fixture["questions"])
    for number in range(event_count - len(events)):
        event_id = f"synthetic_stress_noise_{number:05d}"
        events.append({
            "id": event_id,
            "content": (f"合成隔离压力样本 {number:05d}。这是与现有查询证据无关的背景记录，"
                        f"状态为稳定，批次编号 {number % 97:02d}，仅用于检索规模测试。"),
            "layer": LAYERS[number % len(LAYERS)],
            "sensitivity": SENSITIVITIES[number % len(SENSITIVITIES)],
        })
    for number in range(question_count - len(questions)):
        question = dict(fixture["questions"][number % len(fixture["questions"])])
        question["id"] = f"synthetic_stress_query_{number:03d}"
        questions.append(question)

    manifest = {
        "seed": seed,
        "event_count": len(events),
        "question_count": len(questions),
        "events_sha256": _digest(events),
        "questions_sha256": _digest(questions),
        "construction": ("fixed 1000-event fixture plus unique synthetic distractors; "
                         "fixed queries repeated deterministically to requested count"),
    }
    return {"events": events, "questions": questions, "manifest": manifest}


def run_qdrant_local_recall(fixture=None, *, seed=20261009,
                            model="qwen3-embedding:0.6b",
                            base_url="http://127.0.0.1:11434/v1",
                            batch_size=32, timeout_seconds=120.0,
                            embedding_fn=None):
    """Evaluate synthetic dense recall with an in-memory Qdrant collection."""
    from importlib.metadata import version
    from math import ceil, isfinite, sqrt
    from time import perf_counter
    from qdrant_client import QdrantClient, models

    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size <= 0:
        raise ValueError("batch_size must be a positive integer")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("model must be a non-empty string")
    fixture = build_fixture(seed=seed) if fixture is None else fixture
    events, questions = fixture["events"], fixture["questions"]
    if not events:
        raise ValueError("synthetic embedding benchmark requires at least one event")
    event_ids = [event.get("id") for event in events]
    documents = [event.get("content") for event in events]
    if any(not isinstance(value, str) or not value for value in event_ids + documents):
        raise ValueError("every synthetic event must have a non-empty id and content")
    if len(set(event_ids)) != len(event_ids):
        raise ValueError("synthetic event ids must be unique")
    if embedding_fn is None:
        embed = lambda texts: _request_local_embeddings(
            texts, model=model, base_url=base_url,
            timeout_seconds=timeout_seconds,
        )
    elif callable(embedding_fn):
        embed = embedding_fn
    else:
        raise TypeError("embedding_fn must be callable")

    def unit_vector(vector):
        if not isinstance(vector, (list, tuple)) or not vector:
            raise RuntimeError("embedding vector must be a non-empty list")
        values = [float(value) for value in vector]
        if any(not isfinite(value) for value in values):
            raise RuntimeError("embedding vector contains a non-finite value")
        norm = sqrt(sum(value * value for value in values))
        if norm == 0:
            raise RuntimeError("embedding vector has zero magnitude")
        return [value / norm for value in values]

    def embed_many(texts):
        vectors = []
        for offset in range(0, len(texts), batch_size):
            batch = list(texts[offset:offset + batch_size])
            response = embed(batch)
            if not isinstance(response, (list, tuple)) or len(response) != len(batch):
                raise RuntimeError("embedding provider returned an unexpected vector count")
            vectors.extend(unit_vector(vector) for vector in response)
        return vectors

    client = QdrantClient(":memory:")
    try:
        index_started = perf_counter()
        document_vectors = embed_many(documents)
        dimensions = len(document_vectors[0])
        if any(len(vector) != dimensions for vector in document_vectors):
            raise RuntimeError("document embedding dimensions are inconsistent")
        collection = "synthetic-memory"
        client.create_collection(collection, vectors_config=models.VectorParams(
            size=dimensions, distance=models.Distance.COSINE,
        ))
        for offset in range(0, len(events), 256):
            points = [
                models.PointStruct(
                    id=index + 1, vector=document_vectors[index],
                    payload={"event_id": event_ids[index]},
                )
                for index in range(offset, min(offset + 256, len(events)))
            ]
            client.upsert(collection, points=points, wait=True)
        index_build_ms = (perf_counter() - index_started) * 1000
        event_id_set = set(event_ids)
        rows, latencies = [], []
        instruction = "Instruct: Retrieve the most relevant memory event that answers the user's query."
        for question in questions:
            query = question.get("query")
            evidence_ids = question.get("evidence_ids")
            if not isinstance(query, str) or not query:
                raise ValueError("every synthetic query must be non-empty")
            if not isinstance(evidence_ids, list) or not evidence_ids:
                raise ValueError("every synthetic query must include evidence ids")
            if any(event_id not in event_id_set for event_id in evidence_ids):
                raise ValueError("question references an unknown event")
            started = perf_counter()
            query_vector = embed_many([
                instruction + chr(10) + "Query: " + query,
            ])[0]
            if len(query_vector) != dimensions:
                raise RuntimeError("query and document embedding dimensions differ")
            response = client.query_points(
                collection, query=query_vector, limit=min(10, len(events)),
                with_payload=["event_id"],
            )
            retrieved_ids = []
            for point in response.points:
                payload = point.payload
                event_id = payload.get("event_id") if isinstance(payload, dict) else None
                if not isinstance(event_id, str):
                    raise RuntimeError("Qdrant result is missing event_id payload")
                retrieved_ids.append(event_id)
            rank = next((i for i, event_id in enumerate(retrieved_ids, 1)
                         if event_id in evidence_ids), 0)
            elapsed_ms = (perf_counter() - started) * 1000
            latencies.append(elapsed_ms)
            rows.append({
                "qid": question.get("id"), "qtype": question.get("qtype"),
                "lexical_overlap": question.get("lexical_overlap"),
                "rank": rank, "retrieved_ids": retrieved_ids,
                "latency_ms": elapsed_ms,
            })
    finally:
        client.close()

    ordered = sorted(latencies)
    percentile = lambda p: ordered[max(0, ceil(p * len(ordered)) - 1)] if ordered else 0.0
    return {
        "rows": rows,
        "summary": summarize_rankings(rows, k_values=(1, 5, 10)),
        "latency_ms": {"index_build": index_build_ms,
                       "p50": percentile(0.50), "p95": percentile(0.95)},
        "counts": {"misses": sum(row["rank"] == 0 for row in rows),
                   "rank_after_10": sum(row["rank"] > 10 for row in rows),
                   "indexed_vectors": len(events)},
        "manifest": fixture.get("manifest", {}),
        "parameters": {"model": model, "dimensions": dimensions,
                       "batch_size": batch_size, "storage": "qdrant_local_memory",
                       "qdrant_client_version": version("qdrant-client"),
                       "document_text": "full_synthetic_source_event",
                       "data_scope": "synthetic_only"},
    }


def run_qdrant_source_recall_e2e(fixture=None, *, seed=20261009,
                                 model="qwen3-embedding:0.6b",
                                 base_url="http://127.0.0.1:11434/v1",
                                 batch_size=32, timeout_seconds=120.0,
                                 embedding_fn=None, k=10,
                                 budget_tokens=1200):
    """Exercise vector candidates through Alpha ACL, source reread, and pack on synthetic data."""
    import os
    from tempfile import TemporaryDirectory
    from time import perf_counter
    from unittest.mock import patch
    from qdrant_client import QdrantClient, models
    from .mdcos import MdCGSecure
    from .security import Principal
    from .sources import Ingestor, JsonlSource

    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size <= 0:
        raise ValueError("batch_size must be a positive integer")
    if not isinstance(k, int) or isinstance(k, bool) or k <= 0:
        raise ValueError("k must be a positive integer")
    if not isinstance(budget_tokens, int) or isinstance(budget_tokens, bool) or budget_tokens <= 0:
        raise ValueError("budget_tokens must be a positive integer")
    fixture = build_fixture(seed=seed) if fixture is None else fixture
    events, questions = fixture["events"], fixture["questions"]
    if not events:
        raise ValueError("synthetic embedding benchmark requires at least one event")
    event_ids = [event.get("id") for event in events]
    documents = [event.get("content") for event in events]
    sensitivities = [event.get("sensitivity", "private") for event in events]
    if any(not isinstance(value, str) or not value for value in event_ids + documents):
        raise ValueError("every synthetic event must have a non-empty id and content")
    if len(set(event_ids)) != len(event_ids):
        raise ValueError("synthetic event ids must be unique")
    if any(value not in ("public", "internal", "private", "secret") for value in sensitivities):
        raise ValueError("synthetic E2E fixture supports public, internal, private, and secret events only")
    if embedding_fn is None:
        embed = lambda texts: _request_local_embeddings(
            texts, model=model, base_url=base_url, timeout_seconds=timeout_seconds,
        )
    elif callable(embedding_fn):
        embed = embedding_fn
    else:
        raise TypeError("embedding_fn must be callable")

    def unit_vector(vector):
        from math import isfinite, sqrt
        if not isinstance(vector, (list, tuple)) or not vector:
            raise RuntimeError("embedding vector must be a non-empty list")
        values = [float(value) for value in vector]
        if any(not isfinite(value) for value in values):
            raise RuntimeError("embedding vector contains a non-finite value")
        norm = sqrt(sum(value * value for value in values))
        if norm == 0:
            raise RuntimeError("embedding vector has zero magnitude")
        return [value / norm for value in values]

    def embed_many(texts):
        vectors = []
        for offset in range(0, len(texts), batch_size):
            batch = list(texts[offset:offset + batch_size])
            response = embed(batch)
            if not isinstance(response, (list, tuple)) or len(response) != len(batch):
                raise RuntimeError("embedding provider returned an unexpected vector count")
            vectors.extend(unit_vector(vector) for vector in response)
        return vectors

    all_id_set = set(event_ids)
    key = hashlib.sha256(b"alpha-memory-qdrant-e2e-synthetic-only").digest()
    with TemporaryDirectory(prefix="alpha-memory-qdrant-e2e-") as root:
        source_root = os.path.join(root, "sources")
        os.makedirs(source_root)
        privileged = Principal(
            tenant="synthetic-qdrant-e2e", actor="synthetic-indexer",
            clearance="secret", session="synthetic-qdrant-e2e",
        )
        cg = MdCGSecure(os.path.join(root, "memory"), principal=privileged,
                        master_key=key, autoflush=1)
        node_by_event, ingestion = {}, {}
        with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
            for sensitivity in ("public", "internal", "private", "secret"): 
                selected = [(event_id, event) for event_id, event, level
                            in zip(event_ids, events, sensitivities) if level == sensitivity]
                if not selected:
                    continue
                path = os.path.join(source_root, sensitivity + ".jsonl")
                with open(path, "w", encoding="utf-8") as stream:
                    for seq, (_, event) in enumerate(selected, 1):
                        stream.write(json.dumps({
                            "seq": seq, "session": "synthetic-qdrant-e2e",
                            "role": "user", "text": event["content"],
                        }, ensure_ascii=False) + "\n")
                report = Ingestor(
                    cg, layer="contextual", sensitivity=sensitivity,
                ).ingest(JsonlSource(path), mine_fix_pairs=False)
                if report["denied"] or report["written"] != len(selected):
                    raise RuntimeError(f"synthetic source ingest incomplete: {report}")
                ingestion[sensitivity] = report
                for (event_id, _event), node_id in zip(selected, report["ids"]):
                    node_by_event[event_id] = node_id
        if set(node_by_event) != all_id_set:
            raise RuntimeError("synthetic source ingest did not map every event")

        cg.principal = Principal(
            tenant="synthetic-qdrant-e2e", actor="synthetic-indexer",
            clearance="private", session="synthetic-qdrant-reader",
        )
        acl_started = perf_counter()
        visible_nodes = cg._candidates()
        allowed_node_ids = {node.get("id") or node.get("nid") or os.path.splitext(
            os.path.basename(node.get("path") or ""))[0] for node in visible_nodes}
        allowed_event_ids = {event_id for event_id in event_ids
                             if node_by_event[event_id] in allowed_node_ids}
        if not allowed_event_ids:
            raise RuntimeError("Alpha ACL returned no visible synthetic candidates")
        acl_filter_ms = (perf_counter() - acl_started) * 1000
        client = QdrantClient(":memory:")
        try:
            index_started = perf_counter()
            document_vectors = embed_many(documents)
            dimensions = len(document_vectors[0])
            if any(len(vector) != dimensions for vector in document_vectors):
                raise RuntimeError("document embedding dimensions are inconsistent")
            collection = "synthetic-alpha-memory"
            client.create_collection(collection, vectors_config=models.VectorParams(
                size=dimensions, distance=models.Distance.COSINE,
            ))
            for offset in range(0, len(events), 256):
                points = [models.PointStruct(
                    id=index + 1, vector=document_vectors[index],
                    payload={"event_id": event_ids[index],
                             "node_id": node_by_event[event_ids[index]],
                             "sensitivity": sensitivities[index],
                             "acl_visible": event_ids[index] in allowed_event_ids},
                ) for index in range(offset, min(offset + 256, len(events)))]
                client.upsert(collection, points=points, wait=True)
            index_build_ms = (perf_counter() - index_started) * 1000

            rows, latencies = [], []
            unauthorized_results = 0
            final_visible_count = 0
            instruction = "Instruct: Retrieve the most relevant memory event that answers the user's query."
            node_to_event = {node_id: event_id for event_id, node_id in node_by_event.items()}
            expected_text = {event_id: event["content"]
                             for event_id, event in zip(event_ids, events)}
            for question in questions:
                query, evidence_ids = question.get("query"), question.get("evidence_ids")
                if not isinstance(query, str) or not query:
                    raise ValueError("every synthetic query must be non-empty")
                if not isinstance(evidence_ids, list) or not evidence_ids:
                    raise ValueError("every synthetic query must include evidence ids")
                if any(event_id not in all_id_set for event_id in evidence_ids):
                    raise ValueError("question references an unknown event")
                started = perf_counter()
                final_visible_count = len(allowed_event_ids)
                query_vector = embed_many([
                    instruction + chr(10) + "Query: " + query,
                ])[0]
                if len(query_vector) != dimensions:
                    raise RuntimeError("query and document embedding dimensions differ")
                response = client.query_points(
                    collection, query=query_vector,
                    limit=min(max(k, 10), final_visible_count),
                    query_filter=models.Filter(must=[models.FieldCondition(
                        key="acl_visible", match=models.MatchValue(value=True),
                    )]), with_payload=["event_id", "node_id"],
                )
                qdrant_hits = []
                for point in response.points:
                    payload = point.payload or {}
                    node_id = payload.get("node_id")
                    if node_id not in allowed_node_ids:
                        unauthorized_results += 1
                        continue
                    node = cg.get(node_id)
                    if node is None:
                        continue
                    qdrant_hits.append((node, float(point.score), {"state": None},
                                        [{"path": "qdrant", "rank": len(qdrant_hits) + 1}]))
                with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                    with patch.object(cg, "search_rrf", return_value=(
                            qdrant_hits[:k], {"tier": "synthetic_qdrant", "acl_filtered": True})):
                        packed = cg.recall(query, k=k, budget_tokens=budget_tokens,
                                           judge=False)
                pack = packed["pack"]
                retrieved_events = [node_to_event[item["id"]] for item in pack]
                rank = next((index for index, event_id in enumerate(retrieved_events, 1)
                             if event_id in evidence_ids), 0)
                reread_ok = all(
                    item["content"] == expected_text[node_to_event[item["id"]]]
                    for item in pack
                )
                elapsed_ms = (perf_counter() - started) * 1000
                latencies.append(elapsed_ms)
                rows.append({
                    "qid": question.get("id"), "qtype": question.get("qtype"),
                    "lexical_overlap": question.get("lexical_overlap"),
                    "rank": rank, "retrieved_ids": retrieved_events,
                    "latency_ms": elapsed_ms, "source_reread_verified": reread_ok,
                    "skipped_sources": list(packed["skipped"]),
                    "tokens_used": packed["tokens_used"], "budget": packed["budget"],
                })
        finally:
            client.close()

    from math import ceil
    ordered = sorted(latencies)
    percentile = lambda p: ordered[max(0, ceil(p * len(ordered)) - 1)] if ordered else 0.0
    return {
        "qdrant": {
            "rows": rows, "summary": summarize_rankings(rows, k_values=(1, 5, 10)),
            "latency_ms": {"index_build": index_build_ms,
                           "p50": percentile(0.50), "p95": percentile(0.95)},
            "counts": {"misses": sum(row["rank"] == 0 for row in rows),
                       "indexed_vectors": len(events), "visible_nodes": final_visible_count},
            "manifest": fixture.get("manifest", {}),
            "parameters": {"model": model, "dimensions": dimensions,
                           "storage": "qdrant_local_memory",
                           "query_path": "qdrant_acl_filter_then_alpha_source_reread_pack",
                           "data_scope": "synthetic_only"},
        },
        "security": {
            "indexed_points": len(events), "acl_visible_points": final_visible_count,
            "acl_filtered_points": len(events) - final_visible_count,
            "acl_scans": 1, "acl_filter_mode": "payload_boolean",
            "acl_filter_ms": acl_filter_ms,
            "unauthorized_results": unauthorized_results,
        },
        "source_ingest": {
            sensitivity: {"written": report["written"], "denied": report["denied"]}
            for sensitivity, report in ingestion.items()
        },
    }