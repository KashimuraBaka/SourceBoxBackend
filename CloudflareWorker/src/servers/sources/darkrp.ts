import { UserAgent } from '../ua';
import { ServerSourceBase } from './base';
import type { DarkrpEntry, NormalizedServer } from '../../types';

/**
 * ExG 社区：门户是 Vue SPA，真正的列表来自 `list.darkrp.cn:9000/ServerList/CurrentStatus`。
 * Content-Type 是 text/plain，因此取文本后自行 JSON.parse。
 */
export class DarkrpSource extends ServerSourceBase {
  private static readonly ENDPOINT = 'https://list.darkrp.cn:9000/ServerList/CurrentStatus';

  /** 本社区自己的玩法关键词（顺序即优先级）。 */
  private static readonly MODE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [/躲猫猫|hns/iu, 'hns'],
    [/滑翔|surf/iu, 'surf'],
    [/娱乐闯关|\bmg\b/iu, 'mg'],
    [/僵尸逃跑|\bze\b|pve/iu, 'ze'],
    [/挂机|afk/iu, 'afk'],
  ];

  readonly name = 'darkrp.cn';
  readonly community = 'EXG';

  async fetchRaw(signal: AbortSignal): Promise<unknown> {
    const response = await fetch(DarkrpSource.ENDPOINT, {
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': UserAgent.BROWSER },
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  }

  parse(raw: unknown): NormalizedServer[] {
    let body: unknown;

    try {
      body = JSON.parse(String(raw));
    } catch {
      throw new Error('上游返回的不是 JSON');
    }

    if (!Array.isArray(body)) {
      throw new Error('上游结构不是数组');
    }

    const servers: NormalizedServer[] = [];

    for (const entry of body as DarkrpEntry[]) {
      const server = entry.Server;

      if (!server?.Ip) {
        continue;
      }

      servers.push({
        mode: this.mode(entry.Status?.FullTitle, entry.Status?.ActiveTitle, server.DisplayNameCN, server.DisplayName),
        ip: `${server.Ip}:${server.Port ?? 27015}`,
      });
    }

    return servers;
  }

  /** ExG 的命名：挂机大厅 / 僵尸逃跑ZE / PVE模式 / 躲猫猫 / 娱乐闯关MG / 滑翔SURF。 */
  private mode(...hints: Array<string | undefined>): string {
    for (const candidate of hints) {
      if (!candidate) {
        continue;
      }

      for (const [pattern, mode] of DarkrpSource.MODE_RULES) {
        if (pattern.test(candidate)) {
          return mode;
        }
      }
    }

    return 'cs2';
  }
}
