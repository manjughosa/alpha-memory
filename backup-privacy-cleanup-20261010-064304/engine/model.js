export const config = Object.freeze({
  name: '',
  baseUrl: '',
  api: 'openai-completions',
  apiKeyRef: '',
  models: [],
});

// ── 精确信任（zyq 2026-09-23 方案 C）─────────────────────────────
// 本机网络出口有杀软 TLS 中间人（卡巴自签根替换 DeepSeek 证书链），
// 导致 fetch 偶发 SELF_SIGNED_CERT_IN_CHAIN。
// 解决：把中间人根证书交给 Node 的 NODE_EXTRA_CA_CERTS（标准 CA 扩展，
// 进程启动前由 sidecar 启动环境注入）—— 只并入信任链，不关闭校验
// （rejectUnauthorized 仍为默认 true）。零第三方依赖，保持黑箱独立。
// 可选显式声明：modelConfig.caFile（PEM 路径）会写入同进程的
// NODE_EXTRA_CA_CERTS（仅当该变量尚未设置时），供未配置启动环境时兜底。
export async function invoke(transport, payload, override = {}) {
  if (typeof transport !== 'function') throw new Error('model transport unavailable');
  return transport(payload, { ...config, ...override });
}

export async function openAICompletionsTransport(payload, modelConfig = {}) {
  const model = modelConfig.models?.[0] || {};
  const modelId = model.id || modelConfig.name;
  const baseUrl = String(modelConfig.baseUrl || '').replace(/\/$/, '');
  const keyRef = String(modelConfig.apiKeyRef || '');
  const apiKey = keyRef ? process.env[keyRef] : '';
  if (!baseUrl || !modelId || !apiKey) return { status: 'not-configured' };
  // caFile 兜底：setting 显式声明时，写入进程级 NODE_EXTRA_CA_CERTS。
  // （undici/Node fetch 在首个请求前读该变量；写入必须在 fetch 之前完成。）
  const declaredCa = modelConfig.caFile || ''
  if (declaredCa && !process.env.NODE_EXTRA_CA_CERTS) {
    process.env.NODE_EXTRA_CA_CERTS = declaredCa
  }
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: `${payload.prompt || ''}\n\nYou must respond with a single valid JSON object. Do not include anything outside the JSON.` },
        { role: 'user', content: JSON.stringify({ slot: payload.slot, round: payload.round, actions: payload.actions, targets: payload.targets, context: payload.context }) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: Number(model.maxTokens || 4000),
    }),
    signal: AbortSignal.timeout(Number(modelConfig.timeoutMs || 120000)),
    });
  } catch (e) {
    return { status: 'error', error: `fetch failed: ${e?.cause?.code || e?.cause?.message || e?.message || 'unknown'}` };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { status: 'error', error: body?.error?.message || `HTTP ${response.status}` };
  const text = body?.choices?.[0]?.message?.content || '{}';
  try { return { status: 'ok', ...JSON.parse(text), usage: body.usage || null }; }
  catch { return { status: 'error', error: 'model returned non-JSON content' }; }
}
