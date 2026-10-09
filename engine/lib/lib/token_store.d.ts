/** 凭据来源（用于启动日志与故障定位）。 */
export type TokenSource = 'config' | 'process-env' | 'keyring' | 'issued' | 'disabled' | 'none';
export interface TokenResolution {
    /** 明文令牌；未解析到时为 undefined（md_cg 侧降级只读 guest）。 */
    token?: string;
    source: TokenSource;
    /** 人类可读的补充说明（写启动日志用，含关闭 / 吊销方式）。 */
    note?: string;
    /** 密钥环路径（诊断用）。 */
    keyringPath: string;
}
export interface ResolveTokenOptions {
    /** Python 可执行文件（与 md_cg 子进程同源，保证 import 环境一致）。 */
    python: string;
    /** 显式配置的令牌（config.env.MDCG_TOKEN）。 */
    configured?: string;
    /** 签发主体标识（写入令牌记录，默认 alpha-memory）。 */
    actor?: string;
    /** 签发角色（默认 designer = 设计者载体；其它角色见 tokens.ROLE_SPECS）。 */
    role?: string;
    /** 签发密级上限（默认 internal，与 md_cg 的 DEFAULT_SENSITIVITY 对齐）。 */
    clearance?: string;
    /** 是否允许首启自动签发（默认 true；legacy env 认证场景应传 false）。 */
    autoIssue?: boolean;
    /** 密钥环路径覆盖（默认 ~/.mdcg/token）。 */
    keyringPath?: string;
}
/** 默认密钥环路径：与 md_cg 的 `~/.mdcg/` 约定同目录（`_tokens.json` 亦在此）。 */
export declare function defaultKeyringPath(): string;
/**
 * 解析写入凭据：显式配置 → 进程 env → 密钥环 → 首启自动签发。
 *
 * 纯函数式（无模块级缓存）：一次进程启动只调用一次，且返回值须与当下磁盘
 * 状态一致，缓存反而会让「用户刚删了密钥环」的修复动作不生效。
 */
export declare function resolveToken(opts: ResolveTokenOptions): TokenResolution;
