export const config = Object.freeze({
  name: '',
  baseUrl: '',
  api: 'openai-completions',
  apiKeyRef: '',
  models: [],
});

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
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: payload.prompt || 'Return strict JSON.' },
        { role: 'user', content: JSON.stringify({ slot: payload.slot, round: payload.round, actions: payload.actions, targets: payload.targets, context: payload.context }) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: Number(model.maxTokens || 4000),
    }),
    signal: AbortSignal.timeout(Number(modelConfig.timeoutMs || 120000)),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { status: 'error', error: body?.error?.message || `HTTP ${response.status}` };
  const text = body?.choices?.[0]?.message?.content || '{}';
  try { return { status: 'ok', ...JSON.parse(text), usage: body.usage || null }; }
  catch { return { status: 'error', error: 'model returned non-JSON content' }; }
}
