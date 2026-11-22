import { UserAgent } from './ua';
import type { Baseline, NormalizedServer, RawServersJson } from '../types';

/** 仓库 Servers.json 的加载器（带 1 小时 cf 缓存）。 */
export class BaselineLoader {
  private static readonly TTL_SECONDS = 3600;

  /**
   * 读取所有社区的基础清单（僵尸乐园 / EXG / MOEUB / 风云社 / X社区 / 国外社区）。
   * 失败时抛错：调用方仍可只用活数据源工作。
   */
  async load(owner: string, repo: string, branch: string, signal: AbortSignal): Promise<Baseline> {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/Servers.json`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UserAgent.BROWSER },
      cf: { cacheTtl: BaselineLoader.TTL_SECONDS },
      signal,
    } as RequestInit);

    if (!response.ok) {
      const body = await response.text();
      const contentType = response.headers.get('Content-Type') ?? '?';
      throw new Error(`HTTP ${response.status} ${contentType} <- ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
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
}