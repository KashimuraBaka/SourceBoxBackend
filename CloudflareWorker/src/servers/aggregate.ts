import type { AggregateResult, Baseline, NormalizedServer, ServerSource, SourceError } from '../types';

/** 多个社区数据源的聚合器：并行抓取 → 基线打底 → 整组替换 → 去重排序。 */
export class ServerAggregator {
  /** 列表排序的玩法优先级：挂机服 → ze → mg 闯关 → mg 混战 → surf → kz → bhop → 其他。 */
  private static readonly MODE_ORDER = ['afk', 'ze', 'mg', 'ar', 'surf', 'kz', 'bhop'];

  /** 单个上游的硬超时（毫秒），避免某个站点拖垮整个接口。 */
  private static readonly TIMEOUT_MS = 9000;

  constructor(private readonly sources: ServerSource[]) {}

  /**
   * 抓取所有上游，产出 Servers.json 结构。
   * 只有失败的上游才会进 `sources`（成功不占字节）。
   */
  async collect(baseline: Baseline['servers'] = {}): Promise<AggregateResult> {
    const results = await Promise.all(this.sources.map((source) => this.run(source)));

    // 以 Servers.json 为底：活源抓到的社区整组替换，未覆盖或失败的社区保留基线。
    const data: Record<string, NormalizedServer[]> = {};

    for (const [community, servers] of Object.entries(baseline)) {
      data[community] = servers.map((server) => ({ ...server }));
    }

    const errors: SourceError[] = [];

    for (const [index, result] of results.entries()) {
      const source = this.sources[index];

      if (!source) {
        continue;
      }

      if (result.error) {
        errors.push(result.error);
        continue;
      }

      const seen = new Set<string>();
      const servers: NormalizedServer[] = [];

      for (const server of result.servers) {
        if (seen.has(server.ip)) {
          continue;
        }

        seen.add(server.ip);
        servers.push(server);
      }

      servers.sort((a, b) => ServerAggregator.rank(a.mode) - ServerAggregator.rank(b.mode) || a.ip.localeCompare(b.ip));

      data[source.community] = servers;
    }

    return {
      servers: { update_time: Math.floor(Date.now() / 1000), data },
      sources: errors,
    };
  }

  /** 玩法排序权重；未列出的玩法（zm / hns / ttt / jail / de / cs2 …）统一排在最后。 */
  private static rank(mode: string): number {
    const index = ServerAggregator.MODE_ORDER.indexOf(mode);

    return index < 0 ? ServerAggregator.MODE_ORDER.length : index;
  }

  /** 统一两段式：取原始载荷 → 纯解析；任何一步失败只影响该源。 */
  private async run(source: ServerSource): Promise<{ servers: NormalizedServer[]; error?: SourceError }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), ServerAggregator.TIMEOUT_MS);

    try {
      const raw = await source.fetchRaw(controller.signal);
      return { servers: source.parse(raw) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        servers: [],
        error: { name: source.name, error: message.length > 300 ? `${message.slice(0, 300)}…` : message },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}