import { deriveModePrefer } from './mode';
import type { NormalizedServer, SourceAdapter } from './types';

interface DarkrpServer {
  Id?: string;
  Ip?: string;
  Port?: number;
  DisplayName?: string;
  DisplayNameCN?: string;
  Region?: string;
  Category?: string;
}

interface DarkrpStatus {
  Map?: string;
  MapDisplayName?: string;
  FullTitle?: string;
  ActiveTitle?: string;
  CurrentPlayers?: number;
  MaxPlayers?: number;
}

interface DarkrpEntry {
  Server?: DarkrpServer;
  Status?: DarkrpStatus;
}

const ENDPOINT = 'https://list.darkrp.cn:9000/ServerList/CurrentStatus';
const UA = 'SourceBoxBackend/1.0 (+https://resource.sourcebox.kashimura.cn)';

/**
 * ExG 社区：门户是 Vue SPA，真正的列表来自 `list.darkrp.cn:9000/ServerList/CurrentStatus`。
 * 返回数组：[{ Server:{ Ip, Port, DisplayNameCN, Region, Category }, Status:{ FullTitle, Map, ... } }]。
 * 注意 Content-Type 是 text/plain，需要按文本解析成 JSON。
 */
export const darkrpSource: SourceAdapter = {
  name: 'darkrp.cn',
  community: 'EXG',

  async fetchServers(signal: AbortSignal): Promise<NormalizedServer[]> {
    const response = await fetch(ENDPOINT, {
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': UA },
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = await response.text();
    let body: unknown;

    try {
      body = JSON.parse(raw);
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

      const port = server.Port ?? 27015;
      const ip = `${server.Ip}:${port}`;

      servers.push({
        mode: deriveModePrefer(entry.Status?.FullTitle, entry.Status?.ActiveTitle, server.DisplayNameCN, server.DisplayName, entry.Status?.Map),
        ip,
      });
    }

    return servers;
  },
};
