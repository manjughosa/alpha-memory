// 标准化回合事件的**纯函数**契约：把宿主送来的原始事件归一成 round_tick。
//
// 这里刻意只保留「解析」这一件事。宿主适配的安装、探测、写宿主配置文件
// （宿主设置文件 / 宿主 hooks 文件 之类）属于插件挂载逻辑，
// 已按实施规划第 0 节移除：MCP 不替使用者安装任何东西，也不修改宿主配置。
// 事件源由使用者自己的 Agent/宿主投递，或使用随包 MCP sidecar。
export function normalizeRoundTick(input, previousRound = 0) {
    const sessionId = String(input?.sessionId ?? input?.session?.id ?? input?.session?.sessionId ?? 'session-unknown');
    const round = Number.isInteger(input?.round) && input.round > 0 ? input.round : previousRound + 1;
    const userInput = String(input?.userInput ?? input?.event?.data?.content ?? input?.event?.data?.message?.content ?? '');
    const timestamp = String(input?.timestamp ?? input?.event?.timestamp ?? new Date().toISOString());
    const eventId = String(input?.eventId ?? input?.event?.id ?? `${sessionId}:${round}:${timestamp}`);
    return { event: 'round_tick', sessionId, round, userInput, timestamp, eventId };
}
