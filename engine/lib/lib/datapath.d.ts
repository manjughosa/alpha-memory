export declare const ENV_DATA_ROOT = "MDCG_DATA_ROOT";
export declare const ENV_MDCG_ROOT = "MDCG_ROOT";
/** 发行包根目录：自本模块所在目录向上找 package.json（对构建层级不敏感）。 */
export declare function repoRoot(): string;
export declare const ENV_STATE_ROOT = "MDCG_STATE_ROOT";
export declare const ENV_ALPHA_HOME = "ALPHA_MEMORY_HOME";
/**
 * 用户级状态根（**发行包目录之外**）：路径配置与默认数据根的落点。
 * 优先级：`MDCG_STATE_ROOT` → `ALPHA_MEMORY_HOME` → `~/.alpha-memory`。
 * **不预设任何宿主布局**——宿主环境由母 Agent 在配置时经环境变量注入，
 * 代码里不出现宿主的目录约定。
 */
export declare function stateRoot(): string;
/** 旧版落点（发行包内 `data/`）——更新时会被整个替换，只作兼容读与迁移源。 */
export declare function legacyDataRoot(): string;
/**
 * 用户可编辑的路径配置文件：
 *   `<用户级状态根>/paths.json` → 不存在则回落**旧** `<发行包>/data/paths.json`
 *   （兼容读）→ 都不存在返回新位置（首次写入时创建）。
 * 不做自动复制：配置文件是「谁说了算」的唯一真源，悄悄复制会让旧件的后续编辑
 * 静默失效——迁移只搬数据面，配置显式交给用户搬（或用 `set_user_root`）。
 */
export declare function pathsFile(): string;
/** 生效中的 paths.json 位置来源：`user`=用户级 / `legacy`=旧包内（兼容读）。 */
export declare function pathsFileSource(): 'user' | 'legacy';
/** 默认数据根 = 用户级状态根下 `data/`（**发行包目录之外**，更新不触碰）。 */
export declare function defaultDataRoot(): string;
export interface LegacyMigration {
    /** 是否真的搬了（false 时 `reason` 说明为何没搬）。 */
    ran: boolean;
    reason: string;
    from: string;
    to: string;
    /** 复制成功的顶层条目数。 */
    copied: number;
    /** 复制失败的顶层条目（权限/占用等，逐项吞掉不抛）。 */
    failed: string[];
}
/**
 * 一次性迁移：把旧版留在**发行包内** `data/` 的数据面复制到用户级默认数据根。
 *
 * 触发条件（三条同时满足，缺一不动）：
 *   ① 数据根未被显式配置（env `MDCG_DATA_ROOT` / paths.json 的 `data_root` 都未设，
 *      即 `dataRoot()` 恰为默认值）——显式配置是用户的决定，越权搬运等于改他的真源；
 *   ② 旧位置存在；
 *   ③ 目标顶层条目不存在或为空目录（**不覆盖、不合并**已有数据）。
 *
 * 只复制不删除（旧目录随后由 pnpm 更新自然移除）；`paths.json` 不复制
 * （配置走 `pathsFile()` 兼容读，复制会制造「哪个文件说了算」的两说）。
 * 任何异常逐项吞掉并记入 `failed`——迁移是增益，不该成为启动失败源。
 *
 * 边界（如实）：pnpm 更新是**先替换包目录再启动新代码**，故旧数据在升级瞬间
 * 即已消失，本函数只能接手「旧位置那时仍在」的情形（手工安装、就地覆盖、
 * 或包目录未被清理）；已在升级中丢掉的数据无法由此恢复——发布说明须提示
 * 0.4.8 及更早用户升级前备份 `<profile>/node_modules/<pkg>/data/`。
 */
export declare function migrateLegacyData(): LegacyMigration;
export declare const ENV_CHILD_CWD = "MDCG_CHILD_CWD";
/**
 * 子进程的工作目录（**必须落在发行包目录之外**）。
 *
 * 为什么不能沿用 `repoRoot()`：Windows 不允许删除／改名「正被某进程当作 CWD」
 * 的目录。包按 hoisted 布局安装在 `<profile>/node_modules/<pkg>`，
 * 而包管理器每次更新该包都要先 `rmdir` 包目录 → 子进程一旦把包目录当 CWD，
 * 更新必然 `ERR_PNPM_EBUSY: resource busy or locked`（含升级回滚一起失败，
 * 应用内永远升不动）。注意落点也**不能**是 `<包>/data`——它仍在包内，
 * 实测同样 `err=32`。
 *
 * 落点要求「稳定存在」：进程 cwd 指向已消失的目录会引出新的怪问题，故按稳定度
 * 排候选目录，取**第一个能建成**的：
 *   1. `MDCG_CHILD_CWD`（显式覆盖，由母 Agent 配置时注入）
 *   2. `<状态根>/run`（状态根只由环境变量决定，见 `stateRoot`）
 *   3. 系统临时目录（可能被清理，故排最后）
 * 全部建不成时不抛错，交给 spawn 报错——cwd 落点只是防呆，不该成为启动失败源。
 *
 * 安全性：`python -m` 的模块解析由 `pythonPathValue()` 的 PYTHONPATH 独立保证，
 * 不依赖 cwd；已实测 cwd=包目录 与 cwd=包外 时，MCP initialize 握手与
 * tools/list 工具面（33 个工具）完全一致。
 */
export declare function runRoot(): string;
/** 数据根（记忆/账本/运行态的父目录）。 */
export declare function dataRoot(): string;
/**
 * 认知图根（记忆唯一真源）。
 * @param configured 包配置项 `mdcg.root`；空串/未给=None 表示未指定，走默认。
 */
export declare function mdcgRoot(configured?: string): string;
/**
 * Python 子进程的 PYTHONPATH 值（issue #12）。
 *
 * Python 启动 `-m` 时只把 **cwd** 注入 sys.path——DSH 宿主在发行包外启动时
 * `python -m md_cg.mcp_server` / `python -m md_cg.tokens` 必然
 * ModuleNotFoundError。cwd 与 PYTHONPATH 双保险：后者不依赖 cwd，即使调用方
 * 显式覆盖了启动参数/工作目录也兜得住。顺序：仓根在前（优先随包 md_cg，
 * 防宿主环境同名旧包抢先），进程既有 PYTHONPATH 在后。
 */
export declare function pythonPathValue(): string;
/** 当前解析快照（供启动日志留痕——把「记忆真源在哪」写进可审计痕迹）。 */
export declare function describeDataPaths(configured?: string): Record<string, string | boolean>;
