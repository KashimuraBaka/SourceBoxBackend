import { UserAgent } from '../ua';
import { ServerSourceBase } from './base';
import type { FysDashboard, NormalizedServer } from '../../types';

/**
 * 风雲社：`https://fyscs.cn/dashboard` 页面背后就是 `silverwing/system/dashboard`。
 * 它要求登录器标识头 `X-Client: swallowtail`（缺少时返回 400 `Invalid Client<>!`），
 * 且前置 WAF 只放行浏览器 UA（见 src/servers/ua.ts）。
 */
export class FyscsSource extends ServerSourceBase {
  private static readonly ENDPOINT = 'https://fyscs.cn/silverwing/system/dashboard';

  /** 名称兜底（modeId 没命中时使用），只覆盖本社区出现的玩法。 */
  private static readonly MODE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [/滑翔/iu, 'surf'],
    [/连跳/iu, 'bhop'],
    [/娱乐休闲/iu, 'mg'],
    [/匪镇谍影/iu, 'ttt'],
    [/闲聊|大厅/iu, 'afk'],
    [/魔兽|混战/iu, 'ar'],
    [/僵尸逃跑|僵尸/iu, 'ze'],
  ];

  readonly name = 'fyscs.cn';
  readonly community = '风云社';

  /** 允许覆盖上游地址（`FYS_UPSTREAM_URL`），默认走官方 dashboard 接口。 */
  constructor(private readonly upstreamUrl?: string) {
    super();
  }

  async fetchRaw(signal: AbortSignal): Promise<unknown> {
    const response = await fetch(this.upstreamUrl ?? FyscsSource.ENDPOINT, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': UserAgent.BROWSER,
        'X-Client': 'swallowtail',
        'X-Request': 'XMLHttpRequest',
      },
      signal,
    });

    const text = await this.readText(response);

    // 挑战页也是 200，提前拦下并给出可诊断的信息，避免后面只报“不是 JSON”。
    if (!text.trimStart().startsWith('{')) {
      const contentType = response.headers.get('Content-Type') ?? '?';
      throw new Error(`HTTP ${response.status} ${contentType} 非 JSON: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
    }

    return text;
  }

  parse(raw: unknown): NormalizedServer[] {
    let body: FysDashboard;

    try {
      body = JSON.parse(String(raw)) as FysDashboard;
    } catch {
      throw new Error('上游返回的不是 JSON');
    }

    const list = Array.isArray(body?.servers) ? body.servers : [];
    const servers: NormalizedServer[] = [];

    for (const server of list) {
      const host = server.host?.trim();

      if (!host) {
        continue;
      }

      // 基线 Servers.json 只收 CS2 服（zombieden / EXG 也都是 cs2），这里同样只取 cs2。
      if (server.game && server.game.toLowerCase() !== 'cs2') {
        continue;
      }

      servers.push({
        mode: this.mode(server.modeId, server.name, server.shortName),
        ip: `${host}:${server.port ?? 27015}`,
      });
    }

    if (servers.length === 0) {
      throw new Error('上游没有返回服务器数据');
    }

    return servers;
  }

  /**
   * modeId 的末两位是玩法编号：01 僵尸逃跑 / 02 匪镇谍影 / 04 娱乐休闲 / 07 滑翔 / 08 连跳 /
   * 10 魔兽混战 / 98 闲聊大厅。前后两位是游戏代次（20xx = CS2，10xx = CSGO）。
   */
  private mode(modeId: number | undefined, ...hints: Array<string | undefined>): string {
    if (typeof modeId === 'number' && Number.isFinite(modeId)) {
      switch (modeId % 100) {
        case 1:
          return 'ze';
        case 2:
          return 'ttt';
        case 4:
          return 'mg';
        case 7:
          return 'surf';
        case 8:
          return 'bhop';
        case 10:
          return 'ar';
        case 98:
          return 'afk';
        default:
          break;
      }
    }

    for (const candidate of hints) {
      if (!candidate) {
        continue;
      }

      for (const [pattern, mode] of FyscsSource.MODE_RULES) {
        if (pattern.test(candidate)) {
          return mode;
        }
      }
    }

    return 'cs2';
  }
}
