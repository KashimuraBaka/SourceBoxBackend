import { UserAgent } from '../ua';
import { ServerSourceBase } from './base';
import type { NormalizedServer, ZombiedenPayload } from '../../types';

/**
 * 僵尸乐园：Nuxt 站点，公开接口 `/api/open/servers`。
 * 返回按玩法分组：data[].{ label, servers[].{ ip, title, map } }。
 */
export class ZombiedenSource extends ServerSourceBase {
  private static readonly ENDPOINT = 'https://s.zombieden.cn/api/open/servers';

  /** 本社区自己的玩法关键词（顺序即优先级）。 */
  private static readonly MODE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bbhop\b|连跳/iu, 'bhop'],
    [/\bsurf\b|滑翔/iu, 'surf'],
    [/\bkz\b|攀岩/iu, 'kz'],
    [/\bmg\b|娱乐闯关|迷你游戏/iu, 'mg'],
    [/\bze\b|僵尸逃跑|ze_/iu, 'ze'],
    [/\bde\b|娱乐混战|混战|对抗/iu, 'ar'],
    [/挂机|afk|大厅/iu, 'afk'],
  ];

  readonly name = 's.zombieden.cn';
  readonly community = '僵尸乐园';

  async fetchRaw(signal: AbortSignal): Promise<unknown> {
    const response = await fetch(ZombiedenSource.ENDPOINT, {
      headers: { Accept: 'application/json', 'User-Agent': UserAgent.BROWSER },
      signal,
    });

    return await this.readText(response);
  }

  parse(raw: unknown): NormalizedServer[] {
    let body: ZombiedenPayload;

    try {
      body = JSON.parse(String(raw)) as ZombiedenPayload;
    } catch {
      throw new Error('上游返回的不是 JSON');
    }

    if (body.code !== 0 || !Array.isArray(body.data)) {
      throw new Error(`code=${body.code ?? '?'} message=${body.message ?? ''}`);
    }

    const servers: NormalizedServer[] = [];

    for (const group of body.data) {
      for (const server of group.servers ?? []) {
        const ip = (server.ip ?? server.connectIp ?? '').trim();

        if (!ip) {
          continue;
        }

        servers.push({ mode: this.mode(server.title, group.label, group.id, server.map), ip });
      }
    }

    return servers;
  }

  /** 僵尸乐园的命名：CS2 ZE / MG / KZ / SURF / BHOP + 分组标签。 */
  private mode(...hints: Array<string | undefined>): string {
    const text = hints.filter((hint): hint is string => typeof hint === 'string' && hint.length > 0).join(' ');

    for (const candidate of hints) {
      if (!candidate) {
        continue;
      }

      for (const [pattern, mode] of ZombiedenSource.MODE_RULES) {
        if (pattern.test(candidate)) {
          return mode;
        }
      }
    }

    for (const [pattern, mode] of ZombiedenSource.MODE_RULES) {
      if (pattern.test(text)) {
        return mode;
      }
    }

    return 'cs2';
  }
}
