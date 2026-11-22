/** 与仓库 Servers.json 一致的规范化结构（客户端 SourceServersData 直接反序列化）。 */
export interface NormalizedServer {
  mode: string;
  ip: string;
}

export interface NormalizedServers {
  update_time: number;
  data: Record<string, NormalizedServer[]>;
}

/**
 * 抓取失败的上游。/servers 只在**有失败**时返回该数组，成功的源不占字节
 * （客户端会忽略这个未知字段）。
 */
export interface SourceError {
  name: string;
  error: string;
}

export interface AggregateResult {
  servers: NormalizedServers;
  /** 仅包含失败的上游；全部成功时为空数组（调用方据此决定是否输出字段）。 */
  sources: SourceError[];
}

export interface SourceAdapter {
  /** 写进 data 里的社区名，例如「僵尸乐园」。 */
  readonly community: string;
  /** 诊断名。 */
  readonly name: string;
  fetchServers(signal: AbortSignal): Promise<NormalizedServer[]>;
}
