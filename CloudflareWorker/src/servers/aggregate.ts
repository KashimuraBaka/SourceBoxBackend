import { createFyscsSource } from './fyscs';
import { darkrpSource } from './darkrp';
import { moeubSource } from './moeub';
import type { Baseline } from './baseline';
import type { AggregateResult, NormalizedServer, SourceAdapter, SourceError } from './types';
import { zombiedenSource } from './zombieden';

/** 单个上游的硬超时（毫秒），避免某个站点拖垮整个接口。 */
const SOURCE_TIMEOUT_MS = 9000;

export function createSources(fysUpstreamUrl?: string): SourceAdapter[] {
  return [zombiedenSource, darkrpSource, createFyscsSource(fysUpstreamUrl), moeubSource];
}

async function runSource(source: SourceAdapter): Promise<{ servers: NormalizedServer[]; error?: SourceError }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), SOURCE_TIMEOUT_MS);

  try {
    const servers = await source.fetchServers(controller.signal);
    return { servers };
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

/**
 * 并行抓取所有上游，按社区分组、去重、排序，产出 Servers.json 结构。
 * 只有失败的上游才会进 `sources`（成功不占字节）。
 */
export async function aggregateServers(
  sources: SourceAdapter[],
  baseline: Baseline['servers'] = {},
): Promise<AggregateResult> {
  const results = await Promise.all(sources.map(runSource));

  // 以 Servers.json 为底：活源抓到的社区整组替换，未覆盖或失败的社区保留基线。
  const data: Record<string, NormalizedServer[]> = {};

  for (const [community, servers] of Object.entries(baseline)) {
    data[community] = servers.map((server) => ({ ...server }));
  }

  const errors: SourceError[] = [];

  for (const [index, result] of results.entries()) {
    const source = sources[index];

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

    servers.sort((a, b) => (a.mode === b.mode ? a.ip.localeCompare(b.ip) : a.mode.localeCompare(b.mode)));

    data[source.community] = servers;
  }

  return {
    servers: { update_time: Math.floor(Date.now() / 1000), data },
    sources: errors,
  };
}