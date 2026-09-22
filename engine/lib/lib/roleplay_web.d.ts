/** 在 webServer 上挂载 /roleplay 前缀路由（页面 + API）。失败不影响包主体。
 *
 * @param capability 「身体」能力后端桥（可选）；为 null 时生成接口 fail-closed。
 * @param mdcg       大脑客户端（认知图，唯一真源）；为 null 时落图静默跳过。
 */
export declare function installRoleplayWeb(ctx: any, capability: any, config: any, disposers: any, mdcg?: any): Promise<void>;
