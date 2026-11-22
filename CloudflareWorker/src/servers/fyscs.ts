import { deriveModePrefer } from './mode';
import type { NormalizedServer, SourceAdapter } from './types';

// 该站点前面挂了 `_guard/html.js?js=delay_jump_html` 的 WAF：非浏览器 UA 一律返回挑战页
// （实测 `SourceBoxBackend/1.0`、`Mozilla/5.0 (compatible; …)` 都被拦，只有完整 Chrome UA 才放行）。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 风雲社：`https://fyscs.cn/dashboard` 页面背后就是 `silverwing/system/dashboard`。
 * 它要求登录器标识头 `X-Client: swallowtail`（缺少时返回 400 `Invalid Client<>!`），
 * 带上后返回 `{ servers: [{ game, name, host, port, modeId, currentPlayers, ... }] }`。
 */
const DASHBOARD = 'https://fyscs.cn/silverwing/system/dashboard';

interface FysServer {
  game?: string;
  name?: string;
  shortName?: string;
  host?: string;
  port?: number;
  modeId?: number;
}

interface FysDashboard {
  servers?: FysServer[];
}

/**
 * modeId 的末两位是玩法编号：01 僵尸逃跑 / 02 匪镇谍影 / 04 娱乐休闲 / 07 滑翔 / 08 连跳 /
 * 10 魔兽混战 / 98 闲聊大厅。前后两位是游戏代次（20xx = CS2，10xx = CSGO）。
 */
function modeFromModeId(modeId: number | undefined, ...hints: Array<string | undefined>): string {
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

  return deriveModePrefer(...hints);
}

function parseDashboard(body: unknown): NormalizedServer[] {
  const dashboard = body as FysDashboard;
  const list = Array.isArray(dashboard?.servers) ? dashboard.servers : [];
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
      mode: modeFromModeId(server.modeId, server.name, server.shortName),
      ip: `${host}:${server.port ?? 27015}`,
    });
  }

  return servers;
}

export function createFyscsSource(upstreamUrl?: string): SourceAdapter {
  return {
    name: 'fyscs.cn',
    community: '风云社',

    async fetchServers(signal: AbortSignal): Promise<NormalizedServer[]> {
      const endpoint = upstreamUrl ?? DASHBOARD;

      const response = await fetch(endpoint, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': UA,
          'X-Client': 'swallowtail',
          'X-Request': 'XMLHttpRequest',
        },
        signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      let body: unknown;

      try {
        body = JSON.parse(text);
      } catch {
        const contentType = response.headers.get('Content-Type') ?? '?';
        const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
        throw new Error(`HTTP ${response.status} ${contentType} 非 JSON: ${snippet}`);
      }

      const servers = parseDashboard(body);

      if (servers.length === 0) {
        throw new Error('上游没有返回服务器数据');
      }

      return servers;
    },
  };
}
