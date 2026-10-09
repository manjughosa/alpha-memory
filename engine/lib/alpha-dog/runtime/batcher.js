export function createBatches(slot, round, entries, batchSize, tokenBudget = 0) {
    const sorted = [...entries].sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0));
    const chunks = [];
    let current = [];
    let tokens = 0;
    for (const entry of sorted) {
        const estimate = estimateTokens(entry);
        const fullByCount = current.length >= batchSize;
        const fullByTokens = tokenBudget > 0 && current.length > 0 && tokens + estimate > tokenBudget;
        if (fullByCount || fullByTokens) {
            chunks.push(current);
            current = [];
            tokens = 0;
        }
        current.push(entry);
        tokens += estimate;
    }
    if (current.length)
        chunks.push(current);
    return chunks.map((chunk, offset) => {
        const index = offset + 1;
        const nextIndex = index < chunks.length ? index + 1 : null;
        return { batchId: `${slot.id}-${round}-${String(index).padStart(2, '0')}`, slot: slot.id, fileIds: chunk.map((entry) => String(entry.id ?? entry.path)), entries: chunk, estimatedTokens: chunk.reduce((sum, entry) => sum + estimateTokens(entry), 0), status: 'pending', processed: 0, failed: 0, nextBatch: nextIndex ? `${slot.id}-${round}-${String(nextIndex).padStart(2, '0')}` : null };
    });
}
function estimateTokens(entry) {
    if (Number.isFinite(Number(entry?.tokens)))
        return Math.max(1, Number(entry.tokens));
    if (Number.isFinite(Number(entry?.size)))
        return Math.max(1, Math.ceil(Number(entry.size) / 4));
    return Math.max(1, Math.ceil(JSON.stringify(entry || {}).length / 4));
}
