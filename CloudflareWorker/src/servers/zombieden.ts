import { deriveModePrefer } from './mode';
import type { NormalizedServer, SourceAdapter } from './types';

interface ZombiedenServer {
  ip?: string;
  connectIp?: string;
  title?: string;
  map?: string;
  tags?: string[];
}

interface ZombiedenGroup {
  id?: string;
  label?: string;
  servers?: ZombiedenServer[];
}

interface ZombiedenResponse {
  code?: number;
  message?: string;
  data?: ZombiedenGroup[];
}

const ENDPOINT = 'https://s.zombieden.cn/api/open/servers';
const UA = 'SourceBoxBackend/1.0 (+https://resource.sourcebox.kashimura.cn)';

/**
 * 僵尸乐园：Nuxt 站点，公开接口 `/api/open/servers`。
 * 返回按玩法分组：data[].{ label, servers[].{ ip, title, map } }。
 */
export const zombiedenSource: SourceAdapter = {
  name: 's.zombieden.cn',
  community: '僵尸乐园',

  async fetchServers(signal: AbortSignal): Promise<NormalizedServer[]> {
    const response = await fetch(ENDPOINT, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = (await response.json()) as ZombiedenResponse;

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

        servers.push({
          mode: deriveModePrefer(server.title, group.label, group.id, server.map),
          ip,
        });
      }
    }

    return servers;
  },
};
