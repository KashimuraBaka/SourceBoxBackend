/**
 * CloudflareWorker 下所有 interface 的唯一归属文件：
 * Worker 环境、规范化结构、各源原始载荷、仓库文件、同步脚本。
 */

// ===== Worker 运行时环境（wrangler [vars] / secret） =====
export interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  /** 仓库静态文件（Servers.json / ReleaseNotes.md / 模板）的边缘缓存秒数。 */
  CACHE_SECONDS: string;
  GITHUB_TOKEN?: string;
  /** /servers 聚合结果缓存秒数（默认 3600 = 1 小时）。 */
  SERVERS_CACHE_SECONDS?: string;
  /** 风雲社上游地址（可选；默认走内置端点，见 src/servers/sources/fyscs.ts）。 */
  FYS_UPSTREAM_URL?: string;
}

// ===== 规范化结构（与仓库 Servers.json 一致） =====
export interface NormalizedServer {
  mode: string;
  ip: string;
}

export interface NormalizedServers {
  update_time: number;
  data: Record<string, NormalizedServer[]>;
}

/** 抓取失败的上游。/servers 只在有失败时返回该数组。 */
export interface SourceError {
  name: string;
  error: string;
}

export interface AggregateResult {
  servers: NormalizedServers;
  /** 仅包含失败的上游；全部成功时为空数组（调用方据此决定是否输出字段）。 */
  sources: SourceError[];
}

/** 一个社区的服务器数据源：取原始载荷 + 纯解析。 */
export interface ServerSource {
  /** 诊断名，出现在 sources[].name 里。 */
  readonly name: string;
  /** 写进 data 的社区键，需与仓库 Servers.json 一致。 */
  readonly community: string;
  /** 取原始载荷：HTTP 源返回正文文本，WebSocket 源返回收到的消息文本数组。 */
  fetchRaw(signal: AbortSignal): Promise<unknown>;
  /** 解析原始载荷；结构不符或为空时抛错，由聚合层记录到 sources。 */
  parse(raw: unknown): NormalizedServer[];
}

// ===== 仓库文件 =====
export interface Baseline {
  servers: Record<string, NormalizedServer[]>;
  updateTime: number;
}

/** 仓库 Servers.json 的原始形态（字段可缺省）。 */
export interface RawServersJson {
  update_time?: number;
  data?: Record<string, Array<{ mode?: string; ip?: string }>>;
}

/** GitHub Contents API 返回的文件元信息。 */
export interface RemoteFile {
  sha?: string;
  content?: string;
}

// ===== 各源原始载荷 =====
export interface ZombiedenServer {
  ip?: string;
  connectIp?: string;
  title?: string;
  map?: string;
}

export interface ZombiedenGroup {
  id?: string;
  label?: string;
  servers?: ZombiedenServer[];
}

export interface ZombiedenPayload {
  code?: number;
  message?: string;
  data?: ZombiedenGroup[];
}

export interface DarkrpServer {
  Id?: string;
  Ip?: string;
  Port?: number;
  DisplayName?: string;
  DisplayNameCN?: string;
  Region?: string;
}

export interface DarkrpStatus {
  Map?: string;
  FullTitle?: string;
  ActiveTitle?: string;
}

export interface DarkrpEntry {
  Server?: DarkrpServer;
  Status?: DarkrpStatus;
}

export interface FysServer {
  game?: string;
  name?: string;
  shortName?: string;
  host?: string;
  port?: number;
  modeId?: number;
}

export interface FysDashboard {
  servers?: FysServer[];
}

/** Workers(fetch+Upgrade) 与 Node(global WebSocket) 共用的最小 socket 形状。 */
export interface SocketLike {
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
}

export interface MoeubServer {
  id?: number;
  host?: string;
  port?: number;
  name?: string;
}

export interface MoeubMessage {
  event?: string;
  data?: MoeubServer;
}

// ===== 同步脚本 =====
export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}