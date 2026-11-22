import type { NormalizedServer } from './types';

const UA = 'SourceBoxBackend/1.0 (+https://resource.sourcebox.kashimura.cn)';

/** 基线缓存时长：仓库里的 Servers.json 变动不频繁，1 小时足够。 */
const BASELINE_TTL_SECONDS = 3600;

export interface Baseline {
  servers: Record<string, NormalizedServer[]>;
  updateTime: number;
}

interface RawServersJson {
  update_time?: number;
  data?: Record<string, Array<{ mode?: string; ip?: string }>>;
}

/**
 * 仓库里的 Servers.json 是所有社区的基础清单（僵尸乐园 / EXG / MOEUB / 风云社 / X社区 / 国外社区）。
 * 抓取失败时返回空基线：调用方仍可只用活数据源工作。
 */
export async function fetchBaseline(
  owner: string,
  repo: string,
  branch: string,
  signal: AbortSignal,
): Promise<Baseline> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/Servers.json`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    cf: { cacheTtl: BASELINE_TTL_SECONDS },
    signal,
  } as RequestInit);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const raw = (await response.json()) as RawServersJson;
  const servers: Record<string, NormalizedServer[]> = {};

  for (const [community, list] of Object.entries(raw.data ?? {})) {
    const entries: NormalizedServer[] = [];

    for (const item of list ?? []) {
      const ip = item?.ip?.trim();

      if (!ip) {
        continue;
      }

      entries.push({ mode: item.mode?.trim().toLowerCase() || 'cs2', ip });
    }

    servers[community] = entries;
  }

  return { servers, updateTime: raw.update_time ?? 0 };
}
