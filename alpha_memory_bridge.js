#!/usr/bin/env node
/**
 * Alpha桥.js — md_cg（Alpha记忆大脑）受控入口（算力下沉 / 外部层）
 * 存在理由：Alpha大脑是 python 包（md_cg），而 Aegis 一级门卫只放行 node 调 tools/算力下沉 内的受控 JS。
 * 本桥是唯一合法通道：node 拉起 python -m md_cg.mcp_server，做 JSON-RPC 握手与调用。
 * 作者：设计者 · 2026-09-16
 *
 * 用法：
 *   node Alpha桥.js where     找真 python 与Alpha包，打印版本
 *   node Alpha桥.js link      在无空格枢纽下建立 alpha 联结（幂等）
 *   node Alpha桥.js probe     JSON-RPC 握手 + tools/list（只读，不写一个字节）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, spawn } = require("child_process");
const { normalize, matchesAny } = require("./alpha_normalize.js");

// ── 自包含改造（2026-09-21 · 维护令：MCP 不伸触手到外面）────────────────
// 解析顺序：包内优先 → 包外兜底。包内齐全时，整个 MCP 与外部零耦合。
const _local = (rel) => path.join(__dirname, rel);
const _pick = (localRel, externalPath) => {
  const p = _local(localRel);
  return fs.existsSync(p) ? p : externalPath;
};
const USER_HOME = os.homedir();
const PKG = _pick("engine", process.env.MDCG_ENGINE_ROOT || _local("engine"));
const LINK = process.env.MDCG_LINK_PATH || path.join(USER_HOME, ".mcp", "root", "alpha");
// B1（复苏方案 2026-09-20）：数据根默认值迁出 node_modules 洗衣区——
// 原默认 path.join(PKG,"data","mdcg") 在包内，npm install 会连数据一起洗。
// 现役数据根（含全部桶结构/索引/密钥/审计）应落在**用户目录之外于包**的位置，
// 默认值与之对齐；MDCG_ROOT 环境变量仍可覆盖。
// ── 数据根「验了再信」（工程台纠错④+回归，2026-09-21 重装）──────────
// env 指向的根必须真有 _index.json 且不在存档区（backups/.bak-）才信；
// 否则包内 data/mdcg 兜底；再兜不住才落外部历史路径（理论不可达）。
// 背景：改造前启动的常驻宿主进程环境里揣着旧根值，会静默把引擎引到
// 已冻结/已删除的旧根上 autoinit 空库，形成平行数据。
const _envRoot = process.env.MDCG_ROOT;
const _envTrustable = _envRoot
  && fs.existsSync(path.join(_envRoot, "_index.json"))
  && !/[\\/]backups[\\/]|[\\/]\.bak-/i.test(_envRoot);
const MDCG_ROOT =
  _envTrustable ? _envRoot
  : fs.existsSync(_local("data/mdcg/_index.json")) ? _local("data/mdcg")
  : _local("data/mdcg");
const PY_CANDIDATES = [
  process.env.MDCG_PYTHON,
  _local(process.platform === "win32" ? "runtime/python.exe" : "runtime/bin/python3"),
  process.platform === "win32" ? "python.exe" : "python3",
].filter(Boolean);
const ENV_ALLOWLIST = ["PATH", "SystemRoot", "TEMP", "PYTHONPATH", "PYTHONUTF8", "MDCG_ROOT", "MDCG_POLICY_FILE", "MDCG_TOKEN"];

// Alpha-Dog 是 MCP 的驾驶舱控制面。默认只向 MCP 客户端暴露 On/Off；
// cg/stg 仍由底层内核提供，是否显示由 alpha-dog.setting.json 的 interfaces 决定。
const ALPHA_DOG_TOOL_NAMES = new Set(["Alpha_Dog_On", "Alpha_Dog_Off"]);
const ALPHA_DOG_STATE_PATH = process.env.ALPHA_DOG_CONTROL_STATE || _local("engine/state/mcp-control.json");
function readAlphaDogSetting() {
  const candidates = [process.env.ALPHA_DOG_SETTING, _local("alpha-dog.setting.json"), _local("engine/alpha-dog.setting.json")].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      // 热加载（2026-09-24 · interfaces 开关不再要求重启 MCP）：
      // 原实现每次都 JSON.parse 全文——功能正确但 tools/list 每次都付解析成本；
      // 外层代理模式又把它缓存在进程启动时的一次性变量里，改完 setting 必须
      // 重启 MCP（甚至关机）才生效，"改了没反应"的体感来源。
      // 现改法：按 mtime 缓存——文件没变直接回缓存的解析结果（零解析成本），
      // mtime 变了才重读重解析。读失败/解析失败不吞掉返回 null，由调用方
      // 落到下一个 candidate 或最终默认值（与原 catch-continue 语义一致）。
      const st = fs.statSync(candidate);
      const cache = readAlphaDogSetting._cache;
      if (cache && cache.path === candidate && cache.mtimeMs === st.mtimeMs) return cache.setting;
      const setting = JSON.parse(fs.readFileSync(candidate, "utf8"));
      readAlphaDogSetting._cache = { path: candidate, mtimeMs: st.mtimeMs, setting };
      return setting;
    } catch (_) {}
  }
  return { enabled: false, interfaces: { Alpha_Dog_On: true, Alpha_Dog_Off: true, cg: false, stg: false }, initialization: { mention: "on", status: "unconfigured" } };
}
function alphaDogTools(setting) {
  const tools = [];
  if (setting.interfaces?.Alpha_Dog_On !== false) tools.push({ name: "Alpha_Dog_On", description: "开启 Alpha-Dog 驾驶舱；未初始化时返回结构化初始化请求。", inputSchema: { type: "object", properties: {}, additionalProperties: false } });
  if (setting.interfaces?.Alpha_Dog_Off !== false) tools.push({ name: "Alpha_Dog_Off", description: "关闭 Alpha-Dog 驾驶舱并保存运行状态。", inputSchema: { type: "object", properties: {}, additionalProperties: false } });
  return tools;
}
function loadAlphaDogControlState() {
  try { return JSON.parse(fs.readFileSync(ALPHA_DOG_STATE_PATH, "utf8")); } catch (_) { return { running: false, round: 0, wakeCount: 0, watchdog: "dormant" }; }
}
function saveAlphaDogControlState(state) {
  fs.mkdirSync(path.dirname(ALPHA_DOG_STATE_PATH), { recursive: true });
  const tmp = ALPHA_DOG_STATE_PATH + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, ALPHA_DOG_STATE_PATH);
}
function initializationRequest(setting) {
  const configured = setting.model || {};
  return { name: configured.name || "", baseUrl: configured.baseUrl || "", api: configured.api || "openai-completions", apiKeyRef: configured.apiKeyRef || "", models: configured.models?.length ? configured.models : [{ id: "", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 384000, thinkingLevelMap: { minimal: null, low: null, medium: null } }] };
}
function handleAlphaDogTool(name) {
  const setting = readAlphaDogSetting();
  const previous = loadAlphaDogControlState();
  if (name === "Alpha_Dog_Off") {
    const state = { ...previous, running: false, watchdog: "dormant", pendingWakes: [], savedAt: new Date().toISOString() };
    saveAlphaDogControlState(state);
    return { status: "off", ...state };
  }
  if (setting.initialization?.status === "declined") return { status: "declined", mention: "off", running: false, watchdog: "dormant" };
  if (setting.initialization?.status !== "configured") return { status: "unconfigured", mention: setting.initialization?.mention || "on", running: false, watchdog: "dormant", request: initializationRequest(setting) };
  const state = { ...previous, running: true, watchdog: "dormant", poweredAt: new Date().toISOString() };
  saveAlphaDogControlState(state);
  return { status: "on", ...state };
}

function safeEnv(overrides = {}) {
  const env = {};
  for (const name of ENV_ALLOWLIST) {
    const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key && process.env[key] !== undefined) env[name] = process.env[key];
  }
  for (const name of ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(overrides, name)) env[name] = overrides[name];
  }
  return env;
}

// —— S3（ji 安全线 2026-09-17）：工具副作用【显式分类】，不再从名字猜 ——
// 原实现用 isWriteTool() 从工具名启发式判断（字面 "write" / 含 write 分隔词 /
// cg op=write）。结构性风险：任何未来新增的写工具，只要名字不含 write 且未手工
// 加入名单，就会静默绕过咽喉闸（gated 注入 / required / 长度 / C4 / C8 全不过）。
// 同文件早已承认 mdcg_rejected / mdcg_unresolved 是「文本参数当场落库」的裸口子。
// 现改为显式 allowlist 三分类；【未登记的工具 fail-closed 拒绝发送】——
// 新增工具必须同步登记，由测试强制分类完整性（p2_selftest 的分类完整性用例）。
const TOOL_CLASS = Object.freeze({
  // 直写记忆正文：过完整治理（gated 注入 + required + 最短长度 + C4 exact + C8 语义）
  WRITE_GOVERNED: new Set(["write", "mdcg_remember", "cg"]),
  // 文本参数进Alpha但保留原始/嵌套形态：过归一化卫生层（+ 命中名单者过内容闸）
  WRITE_SPECIAL: new Set([
    "mdcg_rejected", "mdcg_unresolved", "mdcg_propose", "mdcg_review_decide",
    "mdcg_ingest", "mdcg_verify", "mdcg_forget", "mdcg_restore", "mdcg_protect",
    "mdcg_consistency", "mdcg_evolution", "mdcg_predict", "mdcg_identity",
    "mdcg_self_state", "mdcg_whitebox", "mdcg_flywheel", "mdcg_metacognition",
  ]),
  // 纯读：不写库、无文本落点
  READ_ONLY: new Set([
    "stg",   // 2026-09-22 工程台补登：语义时空图四操作（relation/timeline/anchors/consistency）均为纯读。
             // 方案B重建时漏登，导致真 MCP 路径上 stg 被 fail-closed 拒（对抗验收三轮实弹发现）。
    "mdcg_recall", "mdcg_search", "mdcg_get", "mdcg_health", "mdcg_service_info",
    "mdcg_whoami", "mdcg_watermarks", "mdcg_causal", "mdcg_review_list",
    "mdcg_review_records", "mdcg_forgetting_history", "mdcg_mine_fix_pairs",
  ]),
});

function toolClassOf(toolName, rawArgs = {}) {
  if (typeof toolName !== "string" || !toolName) return "UNKNOWN";
  if (TOOL_CLASS.READ_ONLY.has(toolName)) return "READ_ONLY";
  if (TOOL_CLASS.WRITE_SPECIAL.has(toolName)) return "WRITE_SPECIAL";
  if (TOOL_CLASS.WRITE_GOVERNED.has(toolName)) {
    // cg 是多态入口：只有 op=write 才走完整治理，其余按只读处理
    if (toolName === "cg") return rawArgs.op === "write" ? "WRITE_GOVERNED" : "READ_ONLY";
    return "WRITE_GOVERNED";
  }
  return "UNKNOWN";
}

function isKnownTool(toolName) {
  return TOOL_CLASS.READ_ONLY.has(toolName)
    || TOOL_CLASS.WRITE_SPECIAL.has(toolName)
    || TOOL_CLASS.WRITE_GOVERNED.has(toolName);
}

function isWriteTool(toolName, rawArgs = {}) {
  return toolClassOf(toolName, rawArgs) === "WRITE_GOVERNED";
}

// 归一化卫生层覆盖表（设计者裁定 2026-09-16：归一化与闸门解耦——卫生层管所有文本进Alpha的路径，
// 治理层 gated/importance 剥离只管直写记忆的路径，不给无 gated 的工具注入死参数）
const TEXT_FIELDS_BY_TOOL = {
  mdcg_rejected: ["hypothesis", "reason"],
  mdcg_unresolved: ["question"],
  mdcg_propose: ["content"],
};

// P3（设计者同意 2026-09-16）：normalize 包 try/catch，失败即拒绝发送（fail-closed，不落盘）
function failClosedNormalize(label, text) {
  try {
    return normalize(text);
  } catch (e) {
    throw new Error("归一化失败，拒绝发送（" + label + "）: " + e.message);
  }
}

// 内容闸（设计者签核 2026-09-16「准」）：mdcg_rejected / mdcg_unresolved 是「文本参数→当场落库」的裸口子，
// 桥层载入规则库 forbidden 规则，归一化后仍命中即拒发。只查禁词，不套 required 长度门、不注 gated、不剥参数。
const CONTENT_GATE_TOOLS = new Set(["mdcg_rejected", "mdcg_unresolved"]);
const CONTENT_GATE_DEFAULT_POLICY = _local("alpha_review_rules.json");
let POLICY_FORBIDDEN_CACHE = null;
function contentGateReject(toolName, args) {
  if (POLICY_FORBIDDEN_CACHE === null) {
    try {
      const policyFile = process.env.MDCG_POLICY_FILE || CONTENT_GATE_DEFAULT_POLICY;
      POLICY_FORBIDDEN_CACHE = JSON.parse(fs.readFileSync(policyFile, "utf8")).forbidden || [];
    } catch (e) {
      throw new Error("内容闸无法载入规则库，拒绝发送（fail-closed）: " + e.message);
    }
  }
  const fields = TEXT_FIELDS_BY_TOOL[toolName] || [];
  const text = fields.filter((f) => typeof args[f] === "string").map((f) => args[f]).join("\n");
  if (text && matchesAny(text, POLICY_FORBIDDEN_CACHE)) {
    throw new Error("内容闸拒绝：" + toolName + " 文本归一化后仍命中禁词规则，不予发送");
  }
}

// P0-4 咽喉闸（creed 2026-09-17）：consistency 条件闸——归一化后、发送 md_cg 前的前置过滤。
// 五条判据：C1 空内容 / C2 占位模板 / C3 最短长度 / C4 重复内容 / C5 纯格式字符。
// 本闸是前置过滤，md_cg audit 仍为终审。
const GATE_AUDIT_LOG = path.join(__dirname, "consistency-gate-audit.jsonl");
const GATE_HASH_CACHE = path.join(__dirname, ".consistency-hash-cache.json");
function gateAudit(entry) {
  fs.appendFileSync(GATE_AUDIT_LOG, JSON.stringify(entry) + "\n", "utf8");
}
function loadGatePolicy() {
  try {
    const pol = process.env.MDCG_POLICY_FILE || CONTENT_GATE_DEFAULT_POLICY;
    const raw = fs.readFileSync(pol, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.forbidden)) {
      throw new Error("规则库 forbidden 字段缺失或非数组");
    }
    if (!Array.isArray(data.required)) {
      throw new Error("规则库 required 字段缺失或非数组");
    }
    if (!data.required.every((r) => typeof r === "string")) {
      throw new Error("规则库 required 字段必须全为字符串");
    }
    // 载入时全部试编译，非法正则立即 fail-closed
    for (const p of data.forbidden) new RegExp(String(p));
    for (const r of data.required) new RegExp(String(r));
    return { forbidden: data.forbidden, required: data.required };
  } catch (e) {
    // F1 fail-closed：策略文件缺失/损坏 → 拒绝发送，绝不放行
    throw new Error("咽喉闸规则库载入失败（fail-closed）: " + e.message);
  }
}
// 向后兼容：仅返回 forbidden
function loadGateForbidden() { return loadGatePolicy().forbidden; }
// F2：环形 hash 缓存（保留最近 N 条，防 A→B→A 绕过判重）
const GATE_HASH_RING_SIZE = 10;
function contentBigrams(text) {
  const chars = text.replace(/\s+/g, "");
  const bg = new Set();
  for (let i = 0; i < chars.length - 1; i++) bg.add(chars[i] + chars[i + 1]);
  return bg;
}
// ③（avatar 复验 2026-09-17）：exact hash 的拼接编码对齐 dedup_gate_v0.js 的 encPair。
// 原实现是 `scope + "\0" + normalized` 裸拼接，与查重闸的长度前缀编码口径不一致：
// 同一对 (scope, content) 在桥侧与闸侧算出不同 canonical_hash，跨模块判重对不上；
// 且裸拼接本身存在边界歧义（(scope="a\0b",content="c") 与 (scope="a",content="b\0c")
// 拼成同一串）。长度取 UTF-8 字节数，与 dedup_gate_v0.js / vecstore._enc_pair 三方一致。
// 迁移影响：既有 .consistency-hash-cache.json 的 ring 内是旧式 hash，升级后首轮
// 会与旧条目失配（表现为多写一条，不丢数据），ring 会在新口径下自愈。
function encPair(a, b) {
  return Buffer.byteLength(a, "utf8") + "\0" + a + "\0"
    + Buffer.byteLength(b, "utf8") + "\0" + b;
}
// F3 C8：字符级 Jaccard（比 bigram 更适合中文短文本）
function charJaccard(a, b) {
  const sa = new Set(a.replace(/\s+/g, ""));
  const sb = new Set(b.replace(/\s+/g, ""));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter++;
  return inter / (sa.size + sb.size - inter);
}
function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
// F3 C7：模板句式（空洞内容检测）— 纯标点由 C5 拦截，此处不重复
const HOLLOW_PATTERNS = [
  /^第.轮$/,
  /^.{0,10}(更新|完成|已交|已做|进行中)$/,
  /^(ok|好的|收到|了解|明白|知道了)$/i,
];
// ③ fail-closed：读缓存，损坏/非对象 → 抛异常不放行；文件不存在 → 空缓存
function _readHashCache() {
  let raw;
  try { raw = fs.readFileSync(GATE_HASH_CACHE, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return {}; // 首次运行，无缓存文件
    throw e;
  }
  if (!raw || !raw.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new Error("咽喉闸哈希缓存损坏（fail-closed）：" + e.message);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("咽喉闸哈希缓存格式错误（fail-closed）：根不是对象");
  }
  for (const k of Object.keys(parsed)) {
    const entry = parsed[k];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !Array.isArray(entry.ring) || !entry.ring.every((h) => typeof h === "string")) {
      throw new Error("咽喉闸哈希缓存格式错误（fail-closed）：scope 条目损坏（" + String(k).slice(0, 60) + "）");
    }
  }
  return parsed;
}
// —— S1（ji 安全线 2026-09-17）：咽喉闸 exact 判重的跨进程 pending 事务 ——
// 原缺陷（TOCTOU）：consistencyGate 只读缓存即返回 PREPASS，【不建立保留权】；
// hash 提交按 T4-01 推迟到桥成功后。但「预检 → 桥调用 → 提交」整段没有任何跨进程
// 互斥，且 commitGateHash 是「读整个文件 → 改内存 → 直接覆盖」，无锁、非原子。
// 并发序列：A、B 同时读到旧缓存 → 都 PREPASS → 都调 md_cg → A 成功写缓存后，
// B 再成功写缓存 → 相同内容被实际提交两次；不同 scope 并发提交时还会后写覆盖
// 先写，丢失一方 ring。即 T4-01 修对了「提交时机」，但「预检保留权」没有原子化。
// 现修法（与 watchdog_gated_common.js 的 G1 同构）：
//   · 预检在跨进程锁内完成「读 → 判重 → 写 pending 占位」，占位带 owner token；
//   · 桥成功后只有 owner 能 commit（验 token）；桥失败/超时由 owner release；
//   · 缓存写一律「同卷临时文件 + renameSync 原子替换」，杜绝半截文件；
//   · pending 超过 TTL 自动失效，进程中途死亡可自愈，不会永久锁死内容。
const GATE_LOCK_TIMEOUT_MS = 5000;
const GATE_LOCK_STALE_MS = 10000;
const GATE_PENDING_TTL_MS = 120000;

function atomicWriteJson(file, data) {
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now() + "-"
    + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);   // 同卷原子替换
}

// 跨进程互斥锁（通用件）：O_EXCL 独占创建 + 残留锁按龄抢占 + owner 元数据。
// 所有 continue 路径都在 deadline 判定【之后】，与 watchdog 侧 F4 同纪律（禁止无期限自旋）。
// ①（avatar 复验 2026-09-17）：本函数参数化后同时服务咽喉闸 hash 缓存与 C8 bigram 缓存，
// 替换 _withBigramLock 原来的 existsSync 忙等——那个实现有两处硬伤：
//   a) 残留锁（持有者进程崩溃遗留）会让 existsSync 恒真 → 永久阻塞到 5s 超时；
//   b) 「检查存在 → writeFileSync 写锁」非原子，两个进程可能同时自认持锁；
//     且释放用 unlinkSync 不校验 owner，会误删他人活跃锁。
function withFileLock(lockPath, label, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd = null;
  const deadline = Date.now() + GATE_LOCK_TIMEOUT_MS;
  const expiredError = () => new Error(label + "锁超时（等待 " + GATE_LOCK_TIMEOUT_MS + "ms）");
  for (;;) {
    try { fd = fs.openSync(lockPath, "wx"); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw expiredError();
      let st = null;
      try { st = fs.statSync(lockPath); } catch (_) { continue; }
      if (Date.now() - st.mtimeMs > GATE_LOCK_STALE_MS) {
        // 原子抢占：rename 到独占名（同一路径的并发 rename 只有一个能成功）；
        // 抢到后回读内容与抢占前观测值比对，若期间锁已被替换（抢错了他人新锁）则原样放回。
        const stealPath = lockPath + ".stale-" + process.pid + "-" + Date.now();
        let observed = null;
        try { observed = fs.readFileSync(lockPath, "utf8"); } catch (_) {}
        let renamed = false;
        try { fs.renameSync(lockPath, stealPath); renamed = true; } catch (_) {}
        if (renamed) {
          let after = null;
          try { after = fs.readFileSync(stealPath, "utf8"); } catch (_) {}
          if (observed !== null && after !== null && observed !== after) {
            try { fs.renameSync(stealPath, lockPath); } catch (_) {}
          } else {
            try { fs.unlinkSync(stealPath); } catch (_) {}
          }
        }
        continue;
      }
      if (Date.now() > deadline) throw expiredError();
      const spinEnd = Date.now() + 20;
      while (Date.now() < spinEnd) { /* 自旋等待锁释放 */ }
    }
  }
  try {
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch (_) {}
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}

function withGateLock(fn) {
  return withFileLock(GATE_HASH_CACHE + ".lock", "咽喉闸缓存", fn);
}

// ② 桥成功后提交 hash：锁内原子 RMW；验 owner token（S1）；清掉 pending = 终审。
function commitGateHash(scope, hash, now, owner) {
  return withGateLock(() => {
    let cache = {};
    try { cache = _readHashCache(); } catch (e) {
      // ③ 缓存损坏 → fail-closed，不放行
      throw new Error("咽喉闸哈希缓存载入失败（fail-closed）：" + e.message);
    }
    const entry = cache[scope];
    if (owner && entry && entry.pending && entry.pending.owner !== owner) {
      // S1：只有占位 owner 能提交，避免 A 的占位被 B 的提交冒名清掉
      throw new Error("hash 提交被拒：pending owner 不符（"
        + String(entry.pending.owner) + " ≠ " + String(owner) + "）");
    }
    let ring = [];
    if (entry && Array.isArray(entry.ring)) ring = entry.ring;
    else if (entry && typeof entry === "string") ring = [entry];
    if (ring.indexOf(hash) < 0) ring.push(hash);
    if (ring.length > GATE_HASH_RING_SIZE) ring = ring.slice(-GATE_HASH_RING_SIZE);
    cache[scope] = { ring: ring, last: hash, at: now };
    atomicWriteJson(GATE_HASH_CACHE, cache);
  });
}

// 桥失败/超时释放 pending（重试安全；幂等，只释放自己 owner 的占位）。
function releaseGatePending(scope, owner) {
  return withGateLock(() => {
    const cache = _readHashCache();
    const entry = cache[scope];
    if (!entry || !entry.pending) return false;
    if (owner && entry.pending.owner !== owner) return false;
    delete entry.pending;
    cache[scope] = entry;
    atomicWriteJson(GATE_HASH_CACHE, cache);
    return true;
  });
}
function consistencyGate(toolName, args) {
  const content = args.content;
  const scope = args.scope || toolName;
  const now = new Date().toISOString();
  const audit = { at: now, tool: toolName, scope, content_preview: String(content || "").slice(0, 60) };
  // C1: 空内容
  if (content == null || content === "" || (typeof content === "string" && content.trim() === "")) {
    audit.action = "REJECT"; audit.reason = "EMPTY_CONTENT";
    gateAudit(audit); return { ok: false, reason: "EMPTY_CONTENT" };
  }
  // S-02（运维哥安全线 2026-09-17）：content 类型前置校验。
  // 原实现只对字符串做 trim 检查，随后 normalize(String(content)) 把数组/对象
  // 强转成 "1,2,3,..." / "[object Object]" 这类假文本，再交给 C3 长度门、C5 纯格式、
  // C6 信息密度评估——闸门声明的「空/占位/短/重复/纯格式」前提对非字符串输入整体失效
  // （例：[1,2,3,4,5,6,7,8] → "1,2,3,4,5,6,7,8" 长度 15，可连过 C1/C3/C5/C6）。
  // 非字符串一律拒绝：绝不先 String() 再判，避免用字符串化产物冒充内容。
  if (typeof content !== "string") {
    audit.action = "REJECT"; audit.reason = "CONTENT_TYPE_NOT_STRING";
    gateAudit(audit); return { ok: false, reason: "CONTENT_TYPE_NOT_STRING" };
  }
  const normalized = normalize(content);
  // ① 加载规则库（forbidden + required）
  const policy = loadGatePolicy();
  // C2: 占位模板（复用规则库 forbidden）
  if (policy.forbidden.length && matchesAny(normalized, policy.forbidden)) {
    audit.action = "REJECT"; audit.reason = "FORBIDDEN_CONTENT";
    gateAudit(audit); return { ok: false, reason: "FORBIDDEN_CONTENT" };
  }
  // F3 C7: 模板句式（纯轮次/纯状态/纯确认）— 在 required/C3 长度门之前，短句式优先拦截
  const isHollow = HOLLOW_PATTERNS.some(function (p) { return p.test(normalized); });
  if (isHollow) {
    audit.action = "REJECT"; audit.reason = "HOLLOW_PATTERN";
    gateAudit(audit); return { ok: false, reason: "HOLLOW_PATTERN" };
  }
  // C3: 最短长度（在 required 之前，短内容优先拦截）
  if (normalized.length < 8) {
    audit.action = "REJECT"; audit.reason = "TOO_SHORT(min=8,actual=" + normalized.length + ")";
    gateAudit(audit); return { ok: false, reason: "TOO_SHORT" };
  }
  // ① required 规则：内容必须匹配所有 required 模式（C3 已保证 ≥8 字符）
  if (policy.required.length) {
    for (const req of policy.required) {
      if (!new RegExp(req).test(normalized)) {
        audit.action = "REJECT"; audit.reason = "REQUIRED_NOT_MET(" + req + ")";
        gateAudit(audit); return { ok: false, reason: "REQUIRED_NOT_MET" };
      }
    }
  }
  // C5: 纯格式字符（归一化后无实际文字）
  if (!/[\u4e00-\u9fff\w]/.test(normalized)) {
    audit.action = "REJECT"; audit.reason = "NO_TEXT_CONTENT";
    gateAudit(audit); return { ok: false, reason: "NO_TEXT_CONTENT" };
  }
  // F3 C6: 信息密度（去除标点和空白后有效字符占比 <40%）
  const stripped = normalized.replace(/[\s\p{P}\p{S}]/gu, "");
  const density = stripped.length / (normalized.length || 1);
  if (density < 0.4) {
    audit.action = "REJECT"; audit.reason = "LOW_DENSITY(" + density.toFixed(2) + ")";
    gateAudit(audit); return { ok: false, reason: "LOW_DENSITY" };
  }
  // F2 C4 + S1（ji 安全线 2026-09-17）：重复内容——预检在【跨进程锁内】完成
  // 「读 → 判重 → 写 pending 占位」。原实现预检只读不写（T4-01 为避免「失败轮被
  // 误判 DUPLICATE」），但因此没有任何保留权：A、B 并发读到同一旧缓存会双双
  // PREPASS 并各自提交，相同内容被实际写库两次（TOCTOU）。
  // 现写 pending 占位（不是终审 hash）：桥成功由 owner 提交为终审、失败由 owner 释放，
  // 既保住 T4-01 的可重试性，又拿到互斥保留权。
  // ③（avatar 复验 2026-09-17）：对齐 dedup_gate_v0.js 的长度前缀编码，
  // 且 scope 侧必须与闸侧同口径先做 normalize——闸侧 buildHashes 里是
  // `normalize(scope)` 再入 encPair，桥侧原直接用原始 args.scope，
  // 导致含 NUL/零宽/大小写差异的 scope 在两侧算出不同 hash（实测复现）。
  const hash = crypto.createHash("sha256")
    .update(encPair(normalize(scope), normalized), "utf8").digest("hex");
  let verdict = null;
  try {
    verdict = withGateLock(() => {
      const cache = _readHashCache();
      const entry = cache[scope];
      let ring = [];
      if (entry && Array.isArray(entry.ring)) ring = entry.ring;
      else if (entry && typeof entry === "string") ring = [entry];
      if (ring.indexOf(hash) >= 0) return { dup: true, reason: "DUPLICATE_CONTENT" };
      const pend = entry && entry.pending;
      if (pend && (Date.now() - (Number(pend.at) || 0)) < GATE_PENDING_TTL_MS) {
        // 未过期占位：同内容 = 在途重复；异内容 = 同 scope 串行，禁止顶替他人占位
        return { dup: true, reason: pend.hash === hash
          ? "IN_FLIGHT_SAME_CONTENT" : "IN_FLIGHT_OTHER_CONTENT" };
      }
      const owner = process.pid + ":" + Date.now() + ":"
        + Math.random().toString(36).slice(2, 8);
      cache[scope] = { ring: ring, last: (entry && entry.last) || null,
                       at: (entry && entry.at) || null,
                       pending: { hash: hash, owner: owner, at: Date.now() } };
      atomicWriteJson(GATE_HASH_CACHE, cache);
      return { dup: false, owner: owner };
    });
  } catch (e) {
    // ③ 缓存损坏 / 锁超时 → 一律 fail-closed（不猜、不放行）
    const corrupt = /CORRUPT|损坏/.test(String(e.message));
    audit.action = "REJECT";
    audit.reason = corrupt ? "HASH_CACHE_CORRUPT"
      : ("HASH_CACHE_LOCK_FAILED：" + String(e.message).slice(0, 80));
    gateAudit(audit);
    return { ok: false, reason: corrupt ? "HASH_CACHE_CORRUPT" : "HASH_CACHE_LOCK_FAILED" };
  }
  if (verdict.dup) {
    audit.action = "REJECT"; audit.reason = verdict.reason;
    audit.canonical_hash = hash;
    gateAudit(audit); return { ok: false, reason: verdict.reason };
  }
  // ② 预检通过：已持有 pending 保留权，返回 owner 供 main() 提交或释放
  audit.action = "PREPASS"; audit.canonical_hash = hash;
  gateAudit(audit);
  return { ok: true, _hash: hash, _scope: scope, _normalized: normalized,
           _at: now, _owner: verdict.owner };
}
// F3 C8 补充：持久化 bigram 缓存（带简单文件锁，跨进程有效）
const BIGRAM_CACHE_FILE = path.join(__dirname, ".consistency-bigrams.json");
const BIGRAM_LOCK_FILE = path.join(__dirname, ".consistency-bigrams.lock");
const _recentBigrams = []; // 进程内缓存，与落盘数据保持一致（向后兼容导出）
const _BIGRAM_CACHE_SIZE = 10;
function _readBigramsLocked() {
  let raw;
  try { raw = fs.readFileSync(BIGRAM_CACHE_FILE, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return [];
    throw new Error("C8 bigram 缓存读取失败（fail-closed）：" + e.message);
  }
  if (!raw || !raw.trim()) return [];
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("C8 bigram 缓存格式错误（fail-closed）：根不是数组");
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || typeof it !== "object" || Array.isArray(it) ||
        typeof it.scope !== "string" || typeof it.normalized !== "string") {
      throw new Error("C8 bigram 缓存格式错误（fail-closed）：第 " + i + " 条损坏");
    }
  }
  return arr;
}
// ①（avatar 复验 2026-09-17）：复用 withFileLock 同款机制，替换原 existsSync 忙等。
// 原实现的三处硬伤：残留锁（持有者崩溃遗留）令 existsSync 恒真 → 永久阻塞到超时；
// 「检查存在 → 写锁」非原子，两个进程可能同时自认持锁；释放 unlinkSync 不校验 owner，
// 会误删他人活跃锁。现为 O_EXCL 原子创建 + 残留锁按龄 rename 抢占 + owner 元数据。
function _withBigramLock(fn) {
  return withFileLock(BIGRAM_LOCK_FILE, "C8 bigram 缓存", fn);
}
// 包装 consistencyGate：预检 + C8 语义去重 + 桥成功后提交 hash
const _origConsistencyGate = consistencyGate;
function consistencyGateWithSemantic(toolName, args) {
  const result = _origConsistencyGate(toolName, args);
  if (!result.ok) return result;
  const content = args.content;
  const scope = args.scope || toolName;
  const normalized = result._normalized;
  // T4-07（P1）：C8 语义判重持久化——读取落盘 bigram，跨进程/重启仍生效
  const recentBigrams = _withBigramLock(() => _readBigramsLocked());
  // ④ C8：与【同一 scope】的历史 ring 比对（不只最后一条）。
  // S2（ji 安全线 2026-09-17）/ F3（工程线 2026-09-17）：原实现遍历
  // 全部 recentBigrams 且**不带 scope 过滤**，审计 reason 里还打印 prev_scope ——
  // 说明不同 scope 确实参与拒绝。后果有二：
  //   ① 跨项目/跨租户误杀：A 项目写入一句常见约束后，B 项目的同类内容被
  //      SEMANTIC_DUPLICATE 拦下；若 scope 含租户语义，这同时构成可观察侧信道
  //      （以「被拒/未被拒」探测另一 scope 是否存在近似内容）。
  //   ② P3-A 分层拆写自败：watchdog 同轮三段共用 toolName 作 scope，C8 又跨 scope
  //      全量比对，第 2 段会被第 1 段按 0.7742 > 0.75 判重 → 「长期关系」桶被结构性饿死。
  // C4（exact hash）本来就已含 scope，C8 绕过了这条隔离语义；现与 C4 同口径。
  // 若将来确需全局语义查重，必须另设显式策略 + 租户边界，且只降为人工复核信号，
  // 不得自动拒写。
  for (const prev of recentBigrams) {
    if (prev.scope !== scope) continue;
    // ②（avatar 复验 2026-09-17）：判据从【字符级 Jaccard @0.75】回退为
    // 【bigram Jaccard @0.85】。原字符级判据对中文短文本过松——实测一组同主题、
    // 同事实、不同桶的自然中文改写（正是 P3-A 分层拆写期望的输入形态）字符
    // Jaccard 已达 0.7742 > 0.75 即被判重，导致桶被结构性饿死。
    // bigram 保留二元语序信息、分辨率更粗，配合 0.85 阈值把"同义改写"与"真实
    // 重复"分开；叠加 S2 的同 scope 隔离，既不误杀、也不放松对真重复的拦截。
    if (jaccardSimilarity(contentBigrams(normalized), contentBigrams(prev.normalized)) > 0.85) {
      const audit = { at: new Date().toISOString(), tool: toolName, scope,
        content_preview: String(content || "").slice(0, 60),
        action: "REJECT", reason: "SEMANTIC_DUPLICATE(prev_scope=" + prev.scope + ")" };
      gateAudit(audit);
      return { ok: false, reason: "SEMANTIC_DUPLICATE" };
    }
  }
  // T4-01（P0）：此处不再提交 hash、也不再写内存 bigram 缓存——原实现声称
  // 「桥成功后的语义」，实际在闸门通过时即写，若后续 md_cg 调用失败/超时，
  // 同内容重试会被误判 DUPLICATE_CONTENT / SEMANTIC_DUPLICATE（不可重试）。
  // 现改为：只返回 {ok:true,_scope,_hash,_at,_normalized}，
  // 由 main() 在收到 tools/call **成功响应**后调 commitGateHash + recordBigram；
  // 超时 / error 一律不提交。
  return { ok: true, _hash: result._hash, _scope: result._scope, _normalized: result._normalized,
           _at: result._at, _owner: result._owner };
}
// T4-01：C8 bigram 的写入点（只在桥成功后调用）
// T4-07：同时持久化到 .consistency-bigrams.json（带锁）
function recordBigram(scope, normalized) {
  if (!normalized) return;
  // ②（avatar 复验 2026-09-17）：入参防御性再归一化，保证与 C8 比对口径一致。
  // C8 比对时左值是【归一化后】的文本（result._normalized），若调用方传入未归一化
  // 原文（如测试直调/未来新增调用点），两侧口径就会不一致——标点差异会稀释相似度：
  // 实测「…用法，很有收获」vs「…用法，很有收益」在原文口径下 Jaccard=0.9091（应拦），
  // 但左值经 normalize 后全角「，」变半角「,」，多出一个 bigram 差异，重合度跌到
  // 0.85 以下而漏判。normalize 幂等，生产路径（传 gateInfo._normalized）不受影响。
  let norm = normalized;
  try { norm = normalize(normalized); } catch (_) { /* 归一化失败保留原值，不阻断记录 */ }
  _withBigramLock(() => {
    const arr = _readBigramsLocked();
    arr.push({ scope: scope, normalized: norm, at: new Date().toISOString() });
    if (arr.length > _BIGRAM_CACHE_SIZE) arr.splice(0, arr.length - _BIGRAM_CACHE_SIZE);
    fs.writeFileSync(BIGRAM_CACHE_FILE, JSON.stringify(arr, null, 2), "utf8");
  });
  _recentBigrams.push({ scope: scope, normalized: norm });
  if (_recentBigrams.length > _BIGRAM_CACHE_SIZE) _recentBigrams.shift();
}
function sanitizeToolCall(toolName, rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw new Error("工具参数必须是 JSON 对象");
  }
  // S3（ji 安全线 2026-09-17）：未知工具 fail-closed。
  // 宁可拒绝一次未登记的工具，也不允许它静默绕过整条咽喉闸——
  // 这正是原「从工具名猜副作用」的结构性风险所在。
  if (!isKnownTool(toolName)) {
    throw new Error("未知工具，拒绝发送（fail-closed）：" + String(toolName)
      + " —— 新增工具必须显式登记到Alpha桥 TOOL_CLASS"
      + "（READ_ONLY / WRITE_SPECIAL / WRITE_GOVERNED），不允许从工具名推断副作用");
  }
  if (!isWriteTool(toolName, rawArgs)) {
    const args = { ...rawArgs };
    // 归一化卫生层（派活⑨①）：非直写但文本进Alpha的工具，只做归一化，不碰治理
    const fields = TEXT_FIELDS_BY_TOOL[toolName];
    if (fields) {
      let touched = false;
      for (const field of fields) {
        if (typeof args[field] === "string") {
          const clean = failClosedNormalize(toolName + "." + field, args[field]);
          if (clean !== args[field]) { args[field] = clean; touched = true; }
        }
      }
      if (touched) console.error("[Alpha桥] " + toolName + " 文本字段已归一化（卫生层，不改治理）");
    }
    // 内容闸（设计者签核 2026-09-16）：rejected/unresolved 落库前查禁词，命中即拒发
    if (CONTENT_GATE_TOOLS.has(toolName)) contentGateReject(toolName, args);
    // mdcg_review_decide：edits 为嵌套结构，只动 edits.content 且仅当其为字符串（不盲改）
    if (toolName === "mdcg_review_decide" && args.edits && typeof args.edits === "object" && !Array.isArray(args.edits) && typeof args.edits.content === "string") {
      const clean = failClosedNormalize("mdcg_review_decide.edits.content", args.edits.content);
      if (clean !== args.edits.content) {
        args.edits = { ...args.edits, content: clean };
        console.error("[Alpha桥] mdcg_review_decide edits.content 已归一化（卫生层）");
      }
    }
    return { args, stripped: false };
  }
  // S-01（运维哥安全线 2026-09-17）：gated 必须【规范化后判定】。
  // 原实现用严格相等 `=== false`，只拦得住布尔 false；调用方传字符串 "false"、
  // "0"、数字 0 等假值时被当作 truthy 直接放行到下游 md_cg——桥层注释声明的
  // 「拒绝 gated=false 的写入请求」实际失效（类型混淆绕过）。
  const gatedRaw = rawArgs.gated;
  const gatedIsFalse = gatedRaw === false || gatedRaw === 0
    || (typeof gatedRaw === "string"
        && (gatedRaw.trim().toLowerCase() === "false" || gatedRaw.trim() === "0"));
  if (gatedIsFalse) {
    throw new Error("write 调用拒绝：gated=false 不允许通过Alpha桥");
  }

  const gatedArgs = Object.prototype.hasOwnProperty.call(rawArgs, "gated")
    ? { ...rawArgs }
    : { ...rawArgs, gated: true };
  const { importance: _importance, importance_hint: _importanceHint, ...args } = gatedArgs;
  const stripped = Object.prototype.hasOwnProperty.call(rawArgs, "importance") || Object.prototype.hasOwnProperty.call(rawArgs, "importance_hint");
  if (stripped) console.error("[Alpha桥] write 参数已剥离 importance/importance_hint");

  // 归一化接线（2026-09-16 · avatar）：write 内容先归一化再过闸，收窄不可见字符绕过面。
  // 最终裁决仍在 md_cg audit——本桥只改写文本，不做本地否决。
  if (typeof args.content === "string") {
    const raw = args.content;
    const clean = failClosedNormalize(toolName + ".content", raw);
    if (clean !== raw) {
      args.content = clean;
      console.error("[Alpha桥] write content 已归一化（" + raw.length + " → " + clean.length + " 字符），闸门与 audit 将看到归一化文本");
    }
  }
  // P0-4 咽喉闸（creed 2026-09-17 · F1-F3 修复版）：归一化后、发送 md_cg 前的前置条件闸。
  const gateResult = consistencyGateWithSemantic(toolName, args);
  if (!gateResult.ok) {
    throw new Error("咽喉闸拒绝：" + gateResult.reason + "（" + toolName + "）");
  }
  // T4-01：透传闸门信息，供 main() 在 tools/call 成功响应后提交 hash（此处不提交）
  return { args, stripped,
           gateInfo: { _scope: gateResult._scope, _hash: gateResult._hash,
                       _at: gateResult._at, _normalized: gateResult._normalized,
                       _owner: gateResult._owner } };
}

function loadToken() {
  if (process.env.MDCG_TOKEN) return process.env.MDCG_TOKEN;
  const _tokenCandidates = [
    process.env.MDCG_TOKEN_FILE,
    _local("token/alpha-token.txt"),
    path.join(USER_HOME, ".mcp", "alpha-token.txt"),
  ].filter(Boolean);
  const rawFile = _tokenCandidates.find((p) => fs.existsSync(p)) || _tokenCandidates[_tokenCandidates.length - 1];
  // creed 工程线 2026-09-17：原实现裸调 readFileSync——文件缺失/无权限时抛出
  // 原生 uncaught 异常，错误串脱离上下文，排障时无法区分「令牌内容为空」与
  // 「路径根本读不到」。改为 fail-closed + 明确错误串；成功路径行为不变。
  let raw;
  try {
    raw = fs.readFileSync(rawFile, "utf8");
  } catch (e) {
    throw new Error("Alpha令牌读取失败（fail-closed）：" + rawFile
      + " :: " + String(e && e.message || e).slice(0, 120));
  }
  const t = String(raw).trim();
  if (!t) throw new Error("Alpha令牌文件为空或缺失：" + rawFile);
  return t;
}

function findPython() {
  for (const candidate of PY_CANDIDATES) {
    if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", env: safeEnv() });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return "";
}

function main() {
  const argv = process.argv.slice(2);
  const op = argv[0] || "where";
  const py = findPython();

// ── MCP stdio 代理模式（2026-09-21 · 维护决策）────────────────────────
// 无参数启动（= MCP 客户端拉起形态）或显式 op=mcp：本桥即 MCP 服务器壳。
// 方案A：spawn 包内 python -m md_cg.mcp_server（local-first env）。
// 方案B：上行逐行泵＋出站闸——tools/call 过 sanitizeToolCall；抛错→JSON-RPC
//        error(-32602) 同 id 回客户端、不透传 python、会话保活。下行字节流直通。
// 显式 CLI 模式（where/link/probe/policy/pym/maintain）不受影响。
if (argv.length === 0 || op === "mcp") {
  if (!py) { console.error("[Alpha-MCP] 未找到 Python 运行时，代理无法启动"); process.exit(2); }
  let token;
  try { token = loadToken(); } catch (e) { console.error("[Alpha-MCP] " + e.message); process.exit(2); }
  const child = spawn(py, ["-m", "md_cg.mcp_server"], {
    cwd: PKG,
    env: safeEnv({ PYTHONPATH: PKG, PYTHONUTF8: "1", MDCG_ROOT: MDCG_ROOT, MDCG_TOKEN: token, MDCG_POLICY_FILE: process.env.MDCG_POLICY_FILE || CONTENT_GATE_DEFAULT_POLICY }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.on("error", (e) => { console.error("[Alpha-MCP] 引擎拉起失败：" + e.message); process.exit(2); });
  child.stderr.pipe(process.stderr);
  child.on("exit", (code) => {
    if (downbuf.trim() !== "") process.stdout.write(downbuf + "\n");
    process.exit(code === null ? 1 : code);
  });
  // T4-01 生命周期（方案B②）：闸门预检通过→按 id 记 in-flight；
  // 下行同 id 响应：成功→commitGateHash+recordBigram；error/isError→releaseGatePending。
  const inflight = new Map();
  const alphaDogRequestKinds = new Map();
  // 热加载（2026-09-24）：不再缓存启动时的 setting 快照。tools/list 过滤与
  // Alpha_Dog_On/Off 一样走 readAlphaDogSetting()——内部按 mtime 缓存，
  // 文件没变零成本，改完 interfaces 下一次 tools/list 即生效，无需重启 MCP。
  let downbuf = "";
  child.stdout.setEncoding("utf8");
  const downLine = (line) => {
    let msg = null;
    try { msg = JSON.parse(line); } catch (e) { msg = null; }
    if (msg && msg.id !== undefined && msg.id !== null && inflight.has(msg.id)) {
      const gi = inflight.get(msg.id);
      inflight.delete(msg.id);
      const failed = msg.error || (msg.result && msg.result.isError);
      try {
        if (failed) { releaseGatePending(gi._scope, gi._owner); }
        else {
          commitGateHash(gi._scope, gi._hash, gi._at, gi._owner);
          if (typeof recordBigram === "function") recordBigram(gi._scope, gi._normalized);
        }
      } catch (e) { try { releaseGatePending(gi._scope, gi._owner); } catch (_) {} }
    }
    const requestKind = msg && msg.id !== undefined ? alphaDogRequestKinds.get(msg.id) : null;
    if (requestKind === "tools/list" && msg.result && Array.isArray(msg.result.tools)) {
      alphaDogRequestKinds.delete(msg.id);
      const alphaDogSetting = readAlphaDogSetting();   // 热加载：每次 tools/list 现取（mtime 缓存）
      const visibleKernel = msg.result.tools.filter((tool) => (tool.name !== "cg" || alphaDogSetting.interfaces?.cg === true) && (tool.name !== "stg" || alphaDogSetting.interfaces?.stg === true));
      msg.result.tools = [...alphaDogTools(alphaDogSetting), ...visibleKernel];
      process.stdout.write(JSON.stringify(msg) + "\n");
      return;
    }
    process.stdout.write(line + "\n");   // 未改写的下行响应原样透传
  };
  child.stdout.on("data", (chunk) => {
    downbuf += chunk;
    let i;
    while ((i = downbuf.indexOf("\n")) >= 0) {
      const line = downbuf.slice(0, i).replace(/\r$/, "");
      downbuf = downbuf.slice(i + 1);
      if (line.trim() !== "") downLine(line);
    }
  });
  let upbuf = "";
  process.stdin.setEncoding("utf8");
  const pumpLine = (line) => {
    let obj = null;
    try { obj = JSON.parse(line); } catch (e) { obj = null; }
    if (obj && obj.method === "tools/list" && obj.id !== undefined && obj.id !== null) alphaDogRequestKinds.set(obj.id, "tools/list");
    if (obj && obj.method === "tools/call" && obj.id !== undefined && obj.id !== null) {
      const name = obj.params && obj.params.name;
      const rawArgs = (obj.params && obj.params.arguments) || {};
      if (ALPHA_DOG_TOOL_NAMES.has(name)) {
        try {
          const result = handleAlphaDogTool(name);
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: obj.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }) + "\n");
        } catch (e) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: obj.id, error: { code: -32603, message: String(e.message) } }) + "\n");
        }
        return;
      }
      try {
        const sc = sanitizeToolCall(name, rawArgs);
        obj.params = Object.assign({}, obj.params || {}, { arguments: sc.args });
        if (sc.gateInfo) inflight.set(obj.id, sc.gateInfo);
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch (e) {
        const errResp = { jsonrpc: "2.0", id: obj.id, error: { code: -32602, message: String(e.message) } };
        process.stdout.write(JSON.stringify(errResp) + "\n");
      }
      return;
    }
    child.stdin.write(line + "\n");
  };
  process.stdin.on("data", (chunk) => {
    upbuf += chunk;
    let i;
    while ((i = upbuf.indexOf("\n")) >= 0) {
      const line = upbuf.slice(0, i).replace(/\r$/, "");
      upbuf = upbuf.slice(i + 1);
      pumpLine(line);
    }
  });
  process.stdin.on("end", () => {
    if (upbuf.trim() !== "") pumpLine(upbuf);
    try { child.stdin.end(); } catch (e) {}
  });
  return;
}

if (op === "where") {
  console.log("[Alpha桥] python = " + (py || "未找到"));
  console.log("[Alpha桥] Alpha包 = " + (fs.existsSync(PKG) ? PKG : "未找到"));
  console.log("[Alpha桥] 枢纽联结 = " + (fs.existsSync(LINK) ? LINK + "（已存在）" : "尚未建立"));
  if (py) {
    const v = spawnSync(py, ["--version"], { encoding: "utf8", env: safeEnv() });
    console.log("[Alpha桥] 版本 = " + String(v.stdout || v.stderr || "").trim());
  }
  process.exit(0);
}

if (op === "link") {
  if (fs.existsSync(LINK)) {
    console.log("[Alpha桥] 联结已存在，未改动：" + LINK);
    process.exit(0);
  }
  if (!fs.existsSync(PKG)) {
    console.error("[Alpha桥] Alpha包不存在：" + PKG);
    process.exit(2);
  }
  fs.symlinkSync(PKG, LINK, "junction");
  console.log("[Alpha桥] 已建立联结：" + LINK + " -> " + PKG);
  process.exit(0);
}

if (op === "probe") {
  if (!py) {
    console.error("[Alpha桥] 未找到真 python，probe 中止。");
    process.exit(2);
  }
  const child = spawn(py, ["-m", "md_cg.mcp_server"], {
    cwd: PKG,
    env: safeEnv({ PYTHONPATH: PKG, PYTHONUTF8: "1", MDCG_ROOT: MDCG_ROOT, MDCG_TOKEN: loadToken(), MDCG_POLICY_FILE: process.env.MDCG_POLICY_FILE || CONTENT_GATE_DEFAULT_POLICY })
  });
  let buf = "";
  let got = false;
  let gateInfo = null;   // T4-01：闸门信息，tools/call 成功后才提交 hash
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const timer = setTimeout(() => {
    if (!got) {
      console.log("[Alpha桥] probe 超时（20s）。已收字节：" + buf.length);
      console.log("[Alpha桥] stderr 片段：" + String(errBuf).slice(0, 800));
      child.kill();
      process.exit(1);
    }
  }, 20000);
  let errBuf = "";
  child.stderr.on("data", (d) => { errBuf += d.toString(); });
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id === 2) {
        got = true;
        clearTimeout(timer);
        // T4-02（P0）：必须先检查 msg.error —— 原实现不看 error 即当成功，
        // 调用失败（如 audit 拒绝/内部错误）会被误报为「握手成功」。
        // error → 打印全文 + 非零退出；且不提交 hash（T4-01）。
        if (msg.error) {
          // S1：失败路径必须释放 pending 保留权，否则同内容在 TTL 内会被自己挡住
          if (gateInfo) { try { releaseGatePending(gateInfo._scope, gateInfo._owner); } catch (_) {} }
          console.error("[Alpha桥] tools/call 返回 error（不提交 hash）：");
          console.error(JSON.stringify(msg.error, null, 2).slice(0, 4000));
          child.kill();
          process.exit(3);
        }
        const tools = (msg.result && msg.result.tools) || [];
        // T4-01（P0）：只有 **tools/call** 成功才提交 hash（tools/list 不提交）；
        // 提交失败 → 非零退出（fail-closed）。超时/error 均不会走到这里。
        if (gateInfo && !tools.length) {
          if (msg.result && msg.result.isError) {
            // F1（工程线 2026-09-17）：isError 是【正常可达的失败通道】——
            // mcp_server.py 把 call_tool 的任何异常映射为 isError=true，不是异常边角。
            // 原实现只打印一行警告就落到下方 exit(0)：上层 watchdog 据此判 bridgeOk=true、
            // 终审提交自己那份 hash（hashCommitOk=true）、审计行写 BRIDGE_OK、日志写
            // 「落盘成功」——日志/审计/退出码三重指向成功，而内容实际没进库，且此后
            // 同内容恒判 SAME_AS_LAST_PERSISTED，**永久不再重发**。
            // 即 G1 堵住的坑换了个入口回来（G1 防「桥失败被误判 DUPLICATE」，
            // 这里是「桥失败被整段伪装成桥成功并顺手终审」）。
            // 现改为：打印全文 + 非零退出 + 释放 pending → 上一轮重试安全，链路自愈。
            if (gateInfo) { try { releaseGatePending(gateInfo._scope, gateInfo._owner); } catch (_) {} }
            console.error("[Alpha桥] tools/call isError=true（不提交 hash，非零退出）：");
            console.error(JSON.stringify(msg.result, null, 2).slice(0, 4000));
            child.kill();
            process.exit(5);
          }
          try {
            // S1：带上 owner token——只有持占位的一方能提交，杜绝冒名终审
            commitGateHash(gateInfo._scope, gateInfo._hash, gateInfo._at, gateInfo._owner);
            if (typeof recordBigram === "function") {
              recordBigram(gateInfo._scope, gateInfo._normalized);
            }
          } catch (e) {
            // 提交失败同样要释放保留权，否则 pending 残留会挡住同内容的下一轮
            try { releaseGatePending(gateInfo._scope, gateInfo._owner); } catch (_) {}
            console.error("[Alpha桥] hash 提交失败（fail-closed）：" + e.message);
            child.kill();
            process.exit(4);
          }
        }
        if (tools.length) {
          console.log("[Alpha桥] 握手成功。工具数 = " + tools.length);
          console.log("[Alpha桥] 工具名：" + tools.map((t) => t.name).join(", "));
        } else {
          console.log("[Alpha桥] 调用返回：");
          console.log(JSON.stringify(msg.result, null, 2).slice(0, 4000));
        }
        child.kill();
        process.exit(0);
      }
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "alpha-memory-bridge", version: "1.0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const toolName = argv[1];
  if (toolName) {
    let rawArgs;
    try {
      rawArgs = JSON.parse(argv[2] || "{}");
    } catch (e) {
      console.error("[Alpha桥] JSON 参数解析失败：" + e.message);
      child.kill();
      process.exit(2);
    }
    let sc;
    try {
      sc = sanitizeToolCall(toolName, rawArgs);
    } catch (e) {
      console.error("[Alpha桥] " + e.message);
      child.kill();
      process.exit(2);
    }
    const sanitized = sc.args;
    gateInfo = sc.gateInfo || null;
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: sanitized } });
  } else {
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  }
  return;
}

if (op === "policy") {
  const helper = path.join(__dirname, "alpha_policy_check.py");
  const pol = process.env.MDCG_POLICY_FILE || CONTENT_GATE_DEFAULT_POLICY;
  const r = spawnSync(py, [helper], { encoding: "utf8", env: safeEnv({ MDCG_POLICY_FILE: pol, PYTHONUTF8: "1" }) });
  console.log(String(r.stdout || "").trim());
  if (r.stderr) console.error("[Alpha桥] stderr: " + String(r.stderr).trim());
  process.exit(r.status === null ? 1 : r.status);
}
if (op === "pym") {
  const mod = String(argv[1] || "");
  if (!/^md_cg(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(mod)) {
    console.error("[Alpha桥] pym 白名单拒绝：" + mod + "（只允许 md_cg 命名空间下的模块）");
    process.exit(2);
  }
  // B2（复苏方案 2026-09-20）：体检类调用未显式传根时自动补 MDCG_ROOT
  const NEED_ROOT_ARG = new Set(["md_cg.census"]);
  const extraArgs = [];
  if (NEED_ROOT_ARG.has(mod) && argv.length <= 2) {
    extraArgs.push(MDCG_ROOT);
    console.error("[Alpha桥] 已自动补根：" + MDCG_ROOT);
  }
  const pol = process.env.MDCG_POLICY_FILE || CONTENT_GATE_DEFAULT_POLICY;
  const r = spawnSync(py, ["-m", argv[1]].concat(argv.slice(2), extraArgs), { stdio: "inherit", cwd: PKG, env: safeEnv({ PYTHONPATH: PKG, PYTHONUTF8: "1", MDCG_ROOT: MDCG_ROOT, MDCG_POLICY_FILE: pol }) });
  process.exit(r.status === null ? 1 : r.status);
}

// B3（复苏方案 2026-09-20）：maintain — 全库体检（census+orphans+矛盾+superseded）
if (op === "maintain") {
  console.error("[Alpha桥] 已自动补根：" + MDCG_ROOT);
  const idxPath = path.join(MDCG_ROOT, "_index.json");
  if (!fs.existsSync(idxPath)) {
    console.error("[Alpha桥] _index.json 不存在：" + idxPath);
    process.exit(2);
  }
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
  } catch (e) {
    console.error("[Alpha桥] _index.json 解析失败：" + e.message);
    process.exit(2);
  }
  const nodes = Object.entries(idx.nodes || {});
  const total = nodes.length;

  // 按层统计
  const byLayer = {};
  let orphans = [];
  let contradictions = 0;
  let superseded = 0;
  for (const [id, n] of nodes) {
    const layer = n.layer || "unknown";
    byLayer[layer] = (byLayer[layer] || 0) + 1;
    if (n.lifecycle_state === "superseded") superseded++;
    // orphan: 节点在索引但 md 文件不存在
    const mdPath = path.join(MDCG_ROOT, n.path || (layer + "/" + id + ".md"));
    if (!fs.existsSync(mdPath)) orphans.push(id);
    // 矛盾检测：简单计数 edges 中有 conflict 标记的节点
    if (n.edges && Array.isArray(n.edges)) {
      for (const e of n.edges) {
        if (typeof e === "object" && e.relation === "conflict") contradictions++;
      }
    }
  }

  console.log("\n=== 记忆引擎健康度报告 ===");
  console.log("数据根：" + MDCG_ROOT);
  console.log("");
  console.log("【普查】");
  console.log("  总节点：" + total);
  for (const [l, c] of Object.entries(byLayer).sort()) {
    console.log("    层 " + l + "：" + c);
  }
  console.log("");
  // B2 补丁（2026-09-21）：反向孤儿检查——文件存在但索引未登记
  const activeLayerDirs = ["anchor", "knowledge", "contextual"];
  const indexedPaths = new Set();
  for (const [id, n] of nodes) {
    indexedPaths.add(n.path || ((n.layer || "unknown") + "/" + id + ".md"));
  }
  const reverseOrphans = [];
  for (const dir of activeLayerDirs) {
    const dirPath = path.join(MDCG_ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const fn of fs.readdirSync(dirPath)) {
      if (!fn.endsWith(".md")) continue;
      const relPath = dir + "/" + fn;
      if (!indexedPaths.has(relPath)) reverseOrphans.push(relPath);
    }
  }

  console.log("【孤儿节点】");
  if (orphans.length === 0) {
    console.log("  无——所有索引节点均有对应文件");
  } else {
    console.log("  " + orphans.length + " 个：" + orphans.join(", "));
  }
  console.log("【反向孤儿】");
  if (reverseOrphans.length === 0) {
    console.log("  无——所有活跃层文件均已登记");
  } else {
    const show = reverseOrphans.slice(0, 20);
    const etc = reverseOrphans.length > 20 ? " 等" + reverseOrphans.length + "个" : "";
    console.log("  " + reverseOrphans.length + " 个：" + show.join(", ") + etc);
  }
  console.log("");
  console.log("【矛盾节点】" + (contradictions > 0 ? " ⚠ " + contradictions + " 个" : " 0"));
  console.log("【Superseded 节点】" + (superseded > 0 ? " " + superseded + " 个" : " 0"));
  console.log("");
  process.exit(0);
}

}

if (require.main === module) {
  main();
} else {
  module.exports = { ENV_ALLOWLIST, isWriteTool, TOOL_CLASS, toolClassOf, isKnownTool, safeEnv, sanitizeToolCall, consistencyGate: consistencyGateWithSemantic, contentBigrams, jaccardSimilarity, encPair, HOLLOW_PATTERNS, _recentBigrams, loadGatePolicy, commitGateHash, releaseGatePending, recordBigram };
}
