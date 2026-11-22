import { UserAgent } from '../ua';
import { ServerSourceBase } from './base';
import type { MoeubMessage, NormalizedServer, SocketLike } from '../../types';

/**
 * UB 社区（csgo.moeub.cn）：服务器列表不走 REST，而是 WebSocket 推送。
 *   wss://ws2.moeub.cn/ws?files=0&appid=730
 * 连接后逐条推送 `{"event":"server/init","data":{ id, host, port, name, ... }}`，
 * 连满一轮（实测 45 台）后不再有新消息，因此这里「收到就攒、静默 800ms 即收尾」。
 */
export class MoeubSource extends ServerSourceBase {
  private static readonly ENDPOINT = 'https://ws2.moeub.cn/ws?files=0&appid=730';

  /** 首条消息之前最多等这么久（上游冷启动/网络抖动）。 */
  private static readonly FIRST_MESSAGE_TIMEOUT_MS = 5000;

  /** 最后一条 server/init 之后静默多久认为推送结束（心跳/update 不重置该计时）。 */
  private static readonly IDLE_TIMEOUT_MS = 800;

  /** 整轮采集的硬上限：超过就先返回已收到的部分。 */
  private static readonly COLLECT_TIMEOUT_MS = 5000;

  /** 单次采集上限，防止异常情况无限挂起。 */
  private static readonly MAX_MESSAGES = 400;

  /** 本社区自己的玩法关键词（顺序即优先级）。 */
  private static readonly MODE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [/攀岩|kz/iu, 'kz'],
    [/滑翔|surf/iu, 'surf'],
    [/连跳|bhop/iu, 'bhop'],
    [/迷你游戏|娱乐闯关|\bmg\b/iu, 'mg'],
    [/僵尸逃跑|\bze\b/iu, 'ze'],
    [/生化/iu, 'zm'],
    [/娱乐混战|休闲对抗|混战|对抗/iu, 'ar'],
    [/饰品检视|休闲大厅|挂机/iu, 'afk'],
  ];

  readonly name = 'csgo.moeub.cn';
  readonly community = 'MOEUB';

  async fetchRaw(signal: AbortSignal): Promise<unknown> {
    const socket = await this.connect(signal);

    if (!socket) {
      throw new Error('WebSocket 不可用');
    }

    return await new Promise<string[]>((resolve, reject) => {
      const messages: string[] = [];
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const clearTimers = (): void => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
        }

        if (hardTimer !== undefined) {
          clearTimeout(hardTimer);
        }
      };

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();

        try {
          socket.close();
        } catch {
          // 已经关闭时忽略
        }

        if (messages.length === 0) {
          reject(new Error('WebSocket 未推送任何消息'));
          return;
        }

        resolve(messages);
      };

      const fail = (message: string): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        reject(new Error(message));
      };

      idleTimer = setTimeout(finish, MoeubSource.FIRST_MESSAGE_TIMEOUT_MS);
      hardTimer = setTimeout(finish, MoeubSource.COLLECT_TIMEOUT_MS);

      socket.addEventListener('message', (event: MessageEvent) => {
        const text = String(event.data);
        messages.push(text);

        // 只有服务器快照才重置静默计时：心跳/update 不参与，避免一直等到硬上限。
        if (text.includes('"server/init"')) {
          if (idleTimer !== undefined) {
            clearTimeout(idleTimer);
          }

          idleTimer = setTimeout(finish, MoeubSource.IDLE_TIMEOUT_MS);
        }

        if (messages.length >= MoeubSource.MAX_MESSAGES) {
          finish();
        }
      });

      socket.addEventListener('close', finish);
      socket.addEventListener('error', () => {
        if (messages.length === 0) {
          fail('WebSocket 连接错误');
          return;
        }

        finish();
      });

      signal.addEventListener('abort', () => finish(), { once: true });
    });
  }

  parse(raw: unknown): NormalizedServer[] {
    if (!Array.isArray(raw)) {
      throw new Error('WebSocket 载荷不是消息数组');
    }

    const servers = new Map<number, NormalizedServer>();

    for (const item of raw) {
      let message: MoeubMessage;

      try {
        message = JSON.parse(String(item)) as MoeubMessage;
      } catch {
        continue; // 非 JSON 消息直接跳过
      }

      const data = message.data;

      if (message.event !== 'server/init' || !data?.host) {
        continue;
      }

      servers.set(data.id ?? 0, {
        mode: this.mode(data.name),
        ip: `${data.host}:${data.port ?? 27015}`,
      });
    }

    if (servers.size === 0) {
      throw new Error('WebSocket 未推送任何服务器');
    }

    return [...servers.values()];
  }

  /** UB 社区的命名：攀岩竞速 / 僵尸逃跑 / 滑翔竞速 / 连跳竞赛 / 迷你游戏 / 娱乐混战 / 生化模式 / 饰品检视。 */
  private mode(...hints: Array<string | undefined>): string {
    for (const candidate of hints) {
      if (!candidate) {
        continue;
      }

      for (const [pattern, mode] of MoeubSource.MODE_RULES) {
        if (pattern.test(candidate)) {
          return mode;
        }
      }
    }

    return 'cs2';
  }

  /**
   * Workers 与 Node 的唯一差异：如何拿到 WebSocket 句柄。
   * Workers 走 fetch + Upgrade 再 accept；Node（同步脚本）用全局 WebSocket。
   */
  private async connect(signal: AbortSignal): Promise<SocketLike | null> {
    try {
      const response = await fetch(MoeubSource.ENDPOINT, {
        headers: { Upgrade: 'websocket', 'User-Agent': UserAgent.BROWSER },
        signal,
      });
      const socket = (response as unknown as { webSocket?: { accept(): void } & SocketLike }).webSocket;

      if (socket) {
        socket.accept();
        return socket;
      }
    } catch {
      // 落到 Node 分支
    }

    const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => SocketLike }).WebSocket;

    if (!ctor) {
      return null;
    }

    return new ctor(MoeubSource.ENDPOINT);
  }
}
