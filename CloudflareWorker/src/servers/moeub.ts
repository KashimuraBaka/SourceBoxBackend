import { deriveModePrefer } from './mode';
import type { NormalizedServer, SourceAdapter } from './types';

/**
 * UB 社区（csgo.moeub.cn）：服务器列表不走 REST，而是 WebSocket 推送。
 *   wss://ws2.moeub.cn/ws?files=0&appid=730
 * 连接后逐条推送 `{"event":"server/init","data":{ id, host, port, mode, name, ... }}`，
 * 连满一轮（实测 45 台）后不再有新消息，因此这里「收到就攒、静默 1.2s 即收尾」。
 */
const ENDPOINT = 'https://ws2.moeub.cn/ws?files=0&appid=730';

/** 首条消息之前最多等这么久（上游冷启动/网络抖动）。 */
const FIRST_MESSAGE_TIMEOUT_MS = 5000;

/** 最后一条 server/init 之后静默多久认为推送结束（心跳/update 不重置该计时）。 */
const IDLE_TIMEOUT_MS = 800;

/** 整轮采集的硬上限：超过就先返回已收到的部分。 */
const COLLECT_TIMEOUT_MS = 5000;

/** 单次采集上限，防止异常情况无限挂起。 */
const MAX_SERVERS = 400;

interface MoeubServer {
  id?: number;
  host?: string;
  port?: number;
  mode?: number;
  name?: string;
}

interface MoeubMessage {
  event?: string;
  data?: MoeubServer;
}

export const moeubSource: SourceAdapter = {
  name: 'csgo.moeub.cn',
  community: 'UB社区',

  async fetchServers(signal: AbortSignal): Promise<NormalizedServer[]> {
    const response = await fetch(ENDPOINT, {
      headers: { Upgrade: 'websocket' },
      signal,
    });

    const socket = response.webSocket;

    if (!socket) {
      throw new Error(`WebSocket 握手失败：HTTP ${response.status}`);
    }

    socket.accept();

    const servers = new Map<number, NormalizedServer>();

    return await new Promise<NormalizedServer[]>((resolve, reject) => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;

        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
        }

        if (hardTimer !== undefined) {
          clearTimeout(hardTimer);
        }

        try {
          socket.close();
        } catch {
          // 已经关闭时忽略
        }

        if (servers.size === 0) {
          reject(new Error('WebSocket 未推送任何服务器'));
          return;
        }

        resolve([...servers.values()]);
      };

      const fail = (message: string): void => {
        if (settled) {
          return;
        }

        settled = true;

        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
        }

        if (hardTimer !== undefined) {
          clearTimeout(hardTimer);
        }

        reject(new Error(message));
      };

      idleTimer = setTimeout(finish, FIRST_MESSAGE_TIMEOUT_MS);
      hardTimer = setTimeout(finish, COLLECT_TIMEOUT_MS);

      socket.addEventListener('message', (event: MessageEvent) => {
        try {
          const message = JSON.parse(String(event.data)) as MoeubMessage;
          const data = message.data;
          if (message.event === 'server/init' && data?.host) {
            const id = data.id ?? 0;
            servers.set(id, {
              mode: deriveModePrefer(data.name),
              ip: `${data.host}:${data.port ?? 27015}`,
            });

            // 只有服务器快照才重置静默计时：心跳/update 不参与，避免一直等到硬上限。
            if (idleTimer !== undefined) {
              clearTimeout(idleTimer);
            }

            idleTimer = setTimeout(finish, IDLE_TIMEOUT_MS);
          }
        } catch {
          // 非 JSON 或结构不符的消息直接跳过
        }

        if (servers.size >= MAX_SERVERS) {
          finish();
        }
      });

      socket.addEventListener('close', finish);
      socket.addEventListener('error', () => {
        if (servers.size === 0) {
          fail('WebSocket 连接错误');
          return;
        }

        finish();
      });

      signal.addEventListener('abort', () => finish(), { once: true });
    });
  },
};
