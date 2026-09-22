export const FEEDBACK = ['ACCEPT', 'MERGE', 'DROP', 'DEFER', 'CONFLICT'];
export function memoryPropose(input) {
    if (!input.id || !input.batchId || !input.slot)
        throw new TypeError('candidate id/batchId/slot required');
    if (!Array.isArray(input.sources) || input.sources.length === 0)
        throw new TypeError('candidate sources required');
    return { ...input, revision: Math.max(1, Number(input.revision || 1)) };
}
export function memoryFeedback(candidate, feedback) {
    if (feedback.candidateId !== candidate.id)
        throw new Error('feedback candidate mismatch');
    if (!FEEDBACK.includes(feedback.verdict))
        throw new Error(`unknown feedback verdict: ${feedback.verdict}`);
    switch (feedback.verdict) {
        case 'ACCEPT': return { action: 'write', candidate };
        case 'MERGE': return { action: 'merge', candidate: { ...candidate, revision: candidate.revision + 1 }, mergeTarget: feedback.mergeTarget };
        case 'DROP': return { action: 'finish', candidate, reason: feedback.reason };
        case 'DEFER': return { action: 'defer', candidate, retryAfter: feedback.retryAfter, reason: feedback.reason };
        case 'CONFLICT': return { action: 'verify', candidate: { ...candidate, revision: candidate.revision + 1 }, conflicts: feedback.conflicts || [], reason: feedback.reason };
    }
}
export function memoryVerify(candidate, receipt) {
    const valid = receipt.candidateId === candidate.id && receipt.committed === true && receipt.nodeIds.length > 0 && Boolean(receipt.auditReceipt);
    return { confirmed: valid, candidateId: candidate.id, nodeIds: valid ? [...receipt.nodeIds] : [], auditReceipt: valid ? receipt.auditReceipt : null, reason: valid ? 'ok' : 'missing structured commit receipt' };
}
export async function runFeedbackLoop(options) {
    const feedback = await options.preflight(options.candidate);
    const decision = memoryFeedback(options.candidate, feedback);
    if (!['write', 'merge'].includes(decision.action))
        return { status: decision.action, feedback, decision, confirmed: false };
    const candidate = decision.candidate;
    const receipt = await options.write(candidate, feedback);
    const verification = memoryVerify(candidate, receipt);
    return { status: verification.confirmed ? 'completed' : 'failed', feedback, decision, receipt, verification, confirmed: verification.confirmed };
}
