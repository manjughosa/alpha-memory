/**
 * Alpha MCP stdio 桥：管理大脑（md_cg）Python 子进程的生命周期，
 * 通过逐行 JSON-RPC 完成握手、工具发现与调用。
 *
 * 与官方 MCP SDK 客户端不同，本桥零运行时依赖（不引入
 * @modelcontextprotocol/sdk），直接实现Alpha server 使用的 2024-11-05 协议
 * 子集——与Alpha库 D-005「核心零外部依赖」的工程哲学一致。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// issue #19：自检命令文案按平台给出（Windows python / 其它 python3）、
// 并在 ENOENT 时把「解释器名不匹配」这一第一因直接写进日志。
import { explainMissingPython, selfCheckCommand } from './lib/python_path.js';
import { stateRoot } from './lib/datapath.js';
/**
 * 调试探针：记录桥生命周期到独立文件（绕过宿主日志系统，便于定位启动问题）。
 * 落点从**状态根**派生（issue #5）——此前硬编码作者本机绝对路径，
 * 其他用户机器上目录不存在且无权限，探针静默失效，恰在排查启动问题时失明。
 * 状态根只由环境变量决定（见 `datapath.stateRoot`），代码不预设任何宿主布局。
 */
const DEBUG_LOG = join(stateRoot(), 'logs', 'alpha-memory-bridge-debug.log');
let debugLogDirReady = false;
function probe(msg) {
    try {
        if (!debugLogDirReady) {
            mkdirSync(dirname(DEBUG_LOG), { recursive: true });
            debugLogDirReady = true;
        }
        appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
    }
    catch { /* 探针失败忽略 */ }
}
/**
 * 连续启动失败的最大重试次数（issue #6）：指数退避到 maxRetryDelayMs 后
 * 若无上限，python 环境损坏时会以 30s 间隔永久空转（假激活 + 资源浪费）。
 * 达到上限即进入 failed 终态并停止调度；后续所有请求快速失败并给出
 * 明确的修复指引。握手成功后计数归零——运行期偶发崩溃重启不受影响。
 */
const MAX_RETRIES = 8;
export class AlphaBridge {
    options;
    proc = null;
    rl = null;
    nextId = 1;
    pending = new Map();
    started = false;
    disposed = false;
    retryDelayMs = 1000;
    retries = 0;
    retryTimer = null;
    bootQueue = [];
    readyState = 'pending';
    /** issue #7：当前子进程启动时间（计算 uptime，区分秒退与长存后外部关闭） */
    procStartedAt = 0;
    /** issue #7：运行期反复退出的滑动窗口（时间戳列表）——防无限重启刷屏 */
    unexpectedExits = [];
    constructor(options) {
        this.options = options;
    }
    /**
     * 启动Alpha进程并完成握手（initialize → notifications/initialized）。
     * 进程崩溃后自动指数退避重启，并重新握手。
     */
    start() {
        if (this.started || this.disposed)
            return;
        this.started = true;
        this.spawnAndHandshake();
    }
    /** 拉取Alpha的全部工具清单（每次实时请求，不缓存）。 */
    async listTools() {
        const result = await this.request('tools/list', {});
        const tools = result;
        return tools.tools ?? [];
    }
    /** 调用Alpha的一个工具，返回标准化 MCP 结果。 */
    async callTool(name, args, signal) {
        const result = await this.request('tools/call', { name, arguments: args }, signal);
        return result;
    }
    /** 关闭进程并释放资源（写 stdin EOF 优雅退出，超时兜底 kill）。 */
    dispose() {
        this.disposed = true;
        if (this.retryTimer)
            clearTimeout(this.retryTimer);
        const proc = this.proc;
        if (!proc || proc.exitCode !== null)
            return;
        try {
            proc.stdin?.end();
        }
        catch {
            /* 已关闭则忽略 */
        }
        const killer = setTimeout(() => proc.kill(), 2000);
        killer.unref();
    }
    /** 进程是否存活。 */
    get alive() {
        return this.proc !== null && this.proc.exitCode === null;
    }
    /** 桥是否已握手就绪（工具注册用；防止轮询访问 private readyState）。 */
    isReady() {
        return this.readyState === 'ok';
    }
    /** 是否已达放弃终态（连续启动失败超上限，不再自动重启）。 */
    get gaveUp() {
        return this.retries >= MAX_RETRIES;
    }
    /** 等待握手完成（用于 apply 阶段同步就绪）。 */
    waitReady() {
        if (this.readyState === 'ok')
            return Promise.resolve(true);
        if (this.readyState === 'failed')
            return Promise.resolve(false);
        return new Promise((resolve) => this.bootQueue.push(resolve));
    }
    spawnAndHandshake() {
        if (this.disposed)
            return;
        this.procStartedAt = Date.now();
        const { python, args, env, cwd } = this.options;
        const childEnv = { ...process.env, ...env };
        // 确保 DB 目录存在（Alpha server 也会防御性创建，这里提前为可读错误）
        const dbPath = env['ALPHA_CAPABILITY_DB'];
        if (dbPath && dbPath !== ':memory:') {
            try {
                mkdirSync(dirname(dbPath), { recursive: true });
            }
            catch {
                /* 目录创建失败由Alpha侧兜底 */
            }
        }
        const proc = spawn(python, args, {
            env: childEnv,
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.proc = proc;
        this.rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
        proc.stderr?.on('data', (chunk) => {
            // stderr 透传日志（Alpha把日志写在 stderr，避免污染协议流）
            const text = chunk.toString('utf8').trim();
            if (text)
                console.error(`[alpha-memory-bridge] ${text}`);
        });
        this.rl.on('line', (line) => {
            if (!line.trim())
                return;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                console.error(`[alpha-memory-bridge] 非 JSON 输出: ${line.slice(0, 200)}`);
                return;
            }
            if (typeof msg['id'] === 'number') {
                this.settle(msg['id'], msg);
            }
        });
        proc.on('error', (err) => {
            // 进程无法启动（python 不存在等）——响亮失败
            if (!this.disposed) {
                console.error(`[alpha-memory-bridge] Alpha进程启动失败: ${err.message}`);
                // issue #19：ENOENT 的第一因通常不是「环境损坏」，而是解释器名与平台不匹配
                // （Linux/macOS 按 PEP 394 只有 python3）。把成因与修法写进同一条日志——
                // 原始日志把该缺陷伪装成「调用超时」，用户按超时方向排查只会白耗一轮。
                if (err.code === 'ENOENT') {
                    console.error(`[alpha-memory-bridge] ${explainMissingPython(python)}`);
                }
                probe(`spawn error: ${String(err)}`);
                this.readyState = 'failed';
                this.flushBootQueue(false);
                this.scheduleRetry();
            }
        });
        proc.on('exit', (code, signal) => {
            // 探针：写独立文件记录退出（绕过 DSH 日志系统，便于定位）
            const uptimeS = this.procStartedAt
                ? Math.round((Date.now() - this.procStartedAt) / 1000)
                : -1;
            probe(`exit code=${code} signal=${signal} disposed=${this.disposed} ready=${this.readyState} started=${this.started} uptime=${uptimeS}s`);
            console.error(`[alpha-memory-bridge] Alpha进程退出 code=${code} signal=${signal}（存活 ${uptimeS}s）`);
            this.rl?.close();
            this.rl = null;
            this.rejectAll(new Error(`Alpha进程已退出（code=${code} signal=${signal ?? 'none'}）`));
            if (!this.disposed) {
                // issue #7：长存后 code=0 退出 = stdin 被外部关闭（非崩溃）。
                // 记录滑动窗口（10 分钟内 ≥3 次）→ 进入冷却，防「外部反复关闭 +
                // 无限重启」刷屏；冷却结束自动恢复，不进入放弃终态。
                this.unexpectedExits = this.unexpectedExits.filter((t) => Date.now() - t < 600_000);
                this.unexpectedExits.push(Date.now());
                if (uptimeS >= 0 && uptimeS < 5) {
                    console.error(`[alpha-memory-bridge] 进程启动后 5 秒内即退出——请检查 ${python} 可执行文件与 md_cg 依赖。` +
                        `自检 \`${selfCheckCommand(python)}\` 须在发行包根目录运行` +
                        '（包已自动锚定 cwd 与 PYTHONPATH，issue #12）。');
                }
                else if (this.unexpectedExits.length >= 3) {
                    console.error(`[alpha-memory-bridge] 10 分钟内已意外退出 ${this.unexpectedExits.length} 次，` +
                        '冷却 5 分钟后自动恢复。若持续出现，请检查是否有多个进程/脚本'
                        + '同时管理Alpha进程（重复 spawn 会互相关闭对方子进程的 stdin）。');
                    probe(`cooldown: ${this.unexpectedExits.length} unexpected exits in 10min`);
                    this.retryTimer = setTimeout(() => {
                        this.retryTimer = null;
                        this.unexpectedExits = [];
                        if (!this.disposed)
                            this.spawnAndHandshake();
                    }, 300_000);
                    this.retryTimer.unref();
                    return;
                }
                // 有挂起请求的失败是异常的；仅启动失败的等待者得到 false
                this.readyState = 'failed';
                this.flushBootQueue(false);
                this.scheduleRetry();
            }
        });
        void this.handshake();
    }
    async handshake() {
        try {
            await this.request('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'alpha-memory', version: '0.1.0' },
            });
            // 初始化通知：无 id、无响应
            this.writeRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
            // 握手成功：重置退避与失败计数（issue #6）——运行期偶发崩溃重启
            // 不累积启动失败；只有「从未握手成功的连续失败」才走向放弃终态
            this.retryDelayMs = 1000;
            this.retries = 0;
            this.readyState = 'ok';
            this.flushBootQueue(true);
        }
        catch (err) {
            if (!this.disposed) {
                console.error(`[alpha-memory-bridge] 握手失败: ${err.message}`);
                probe(`handshake failed: ${String(err)}`);
                this.readyState = 'failed';
                this.flushBootQueue(false);
                this.scheduleRetry();
            }
        }
    }
    scheduleRetry() {
        if (this.disposed || this.retryTimer || this.gaveUp)
            return;
        this.retries += 1;
        if (this.gaveUp) {
            // issue #6：放弃机制——明确终态，停止后台空转；请求方收到清晰错误而非超时
            this.readyState = 'failed';
            this.flushBootQueue(false);
            console.error(`[alpha-memory-bridge] 连续启动失败 ${this.retries} 次，已停止自动重启（不再后台空转）。` +
                `请检查 ${this.options.python} 可执行文件与 md_cg 依赖；` +
                `自检 \`${selfCheckCommand(this.options.python)}\` 须在发行包根目录运行` +
                '（包已自动锚定 cwd 与 PYTHONPATH，issue #12），修复后在你的宿主中重新启用 alpha-memory MCP server。');
            probe(`give up: ${this.retries} consecutive failures, entering failed terminal state`);
            return;
        }
        const delay = this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.options.maxRetryDelayMs);
        console.error(`[alpha-memory-bridge] 将进行第 ${this.retries}/${MAX_RETRIES} 次重试（${delay}ms 后）`);
        probe(`schedule retry ${this.retries}/${MAX_RETRIES} in ${delay}ms`);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.disposed)
                this.spawnAndHandshake();
        }, delay);
        this.retryTimer.unref();
    }
    writeRaw(msg) {
        const proc = this.proc;
        if (!proc || !proc.stdin?.writable) {
            throw new Error('Alpha进程不可写');
        }
        proc.stdin.write(JSON.stringify(msg) + '\n');
    }
    request(method, params, signal) {
        // issue #6：放弃终态下快速失败——之前进程不在且不再重启，请求只能白等超时
        if (this.gaveUp) {
            return Promise.reject(new Error('Alpha进程不可用：连续启动失败已达上限，已停止重试。' +
                `请检查 ${this.options.python} 可执行文件与 md_cg 依赖` +
                `（自检 \`${selfCheckCommand(this.options.python)}\` 须在发行包根目录运行），` +
                '修复后重新启用 alpha-memory MCP server。'));
        }
        const id = this.nextId++;
        const timeout = this.options.timeoutMs;
        // P0 修复（GPT 审查）：定时器直接调 settle——settle 内部会 delete + clearTimeout
        // 并 reject。此前先 pending.delete(id) 再 settle()，settle 找不到 entry 直接
        // return，Promise 永不 resolve/reject（超时逻辑完全失效，子进程挂死时包永久挂住）。
        const timer = setTimeout(() => {
            this.settle(id, {
                error: { code: -32000, message: `Alpha调用超时（${timeout}ms）：${method}` },
            });
        }, timeout);
        if (signal?.aborted) {
            clearTimeout(timer);
            return Promise.reject(new Error(`已取消：${method}`));
        }
        const onAbort = () => {
            this.settle(id, { error: { code: -32800, message: `已取消：${method}` } });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, timer });
        });
        // settle 后移除 abort 监听，避免内存积累
        promise.finally(() => {
            signal?.removeEventListener('abort', onAbort);
        }).catch(() => { });
        try {
            this.writeRaw({ jsonrpc: '2.0', id, method, params });
        }
        catch (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            signal?.removeEventListener('abort', onAbort);
            return Promise.reject(err);
        }
        return promise;
    }
    settle(id, msg) {
        const entry = this.pending.get(id);
        if (!entry)
            return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (msg['error']) {
            const err = msg['error'];
            entry.reject(new Error(`Alpha错误 ${err.code ?? ''}: ${err.message ?? 'unknown'}`));
        }
        else {
            entry.resolve(msg['result']);
        }
    }
    rejectAll(reason) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(reason);
        }
        this.pending.clear();
    }
    flushBootQueue(ok) {
        const queue = this.bootQueue;
        this.bootQueue = [];
        for (const cb of queue)
            cb(ok);
    }
}
