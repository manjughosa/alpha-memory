export class AlphaDogWakeQueue {
    queue = [];
    /** status 缺省为 queued；恢复持久化状态时可显式传入既有状态（running 由调用方先归一为 queued）。 */
    enqueue(plan) { const item = { ...plan, status: plan.status || 'queued' }; this.queue.push(item); return item; }
    next() { const item = this.queue.find((entry) => entry.status === 'queued'); if (item)
        item.status = 'running'; return item ?? null; }
    complete(id, ok = true) { const item = this.queue.find((entry) => entry.id === id); if (item)
        item.status = ok ? 'completed' : 'failed'; return item ?? null; }
    cancelPending() { for (const item of this.queue)
        if (item.status === 'queued')
            item.status = 'cancelled'; }
    /** 恢复最小单位：仅失败项可回到队列；已完成/运行中不动（防重复处理）。 */
    requeue(id) { const item = this.queue.find((entry) => entry.id === id); if (!item || item.status !== 'failed')
        return null; item.status = 'queued'; return item; }
    requeueFailed() { let n = 0; for (const item of this.queue)
        if (item.status === 'failed') {
            item.status = 'queued';
            n += 1;
        } return n; }
    snapshot() { return this.queue.map((item) => ({ ...item })); }
}
