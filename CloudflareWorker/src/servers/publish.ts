import { UserAgent } from './ua';
import type { Env, NormalizedServers, RemoteFile } from '../types';

/**
 * 把聚合结果异步写回仓库的 Servers.json。
 *
 * 由 /servers 在缓存刷新时通过 ctx.waitUntil 触发：不阻塞响应，失败只打日志。
 * 需要 Worker 上配置可写仓库的 GITHUB_TOKEN（Contents: Read and write）。
 */
export class ServersPublisher {
  private static readonly FILE = 'Servers.json';
  private static readonly COMMIT_MESSAGE = 'chore(servers): 自动同步社区服务器列表';
  private static readonly API_BASE = 'https://api.github.com';

  constructor(private readonly env: Env) {}

  /**
   * 远端内容与本次结果一致时跳过提交；否则 PUT 一个新 commit。
   * 返回值只用于日志：'skipped-no-token' | 'unchanged' | 'committed:<sha>'
   */
  async publish(payload: NormalizedServers): Promise<string> {
    const token = this.env.GITHUB_TOKEN;

    if (!token) {
      return 'skipped-no-token';
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UserAgent.BROWSER,
    };
    const url = `${ServersPublisher.API_BASE}/repos/${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}/contents/${ServersPublisher.FILE}`;

    const current = await fetch(`${url}?ref=${encodeURIComponent(this.env.GITHUB_BRANCH)}`, { headers });

    if (!current.ok) {
      throw new Error(`读取远端 ${ServersPublisher.FILE} 失败：HTTP ${current.status}`);
    }

    const remote = (await current.json()) as RemoteFile;
    const remoteText = remote.content ? ServersPublisher.decodeBase64(remote.content) : '';

    if (remoteText) {
      try {
        const parsed = JSON.parse(remoteText) as NormalizedServers;

        if (ServersPublisher.signature(parsed.data ?? {}) === ServersPublisher.signature(payload.data)) {
          return 'unchanged';
        }
      } catch {
        // 远端不是合法 JSON 时直接覆盖
      }
    }

    const content = `${JSON.stringify(payload, null, 2)}\n`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: ServersPublisher.COMMIT_MESSAGE,
        content: ServersPublisher.encodeBase64(content),
        branch: this.env.GITHUB_BRANCH,
        ...(remote.sha ? { sha: remote.sha } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`提交失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    }

    const result = (await response.json()) as { commit?: { sha?: string } };

    return `committed:${result.commit?.sha?.slice(0, 7) ?? '?'}`;
  }

  /** 与 scripts/update-servers.ts 一致的签名：忽略 update_time，只比较社区/模式/地址。 */
  private static signature(data: NormalizedServers['data']): string {
    return Object.keys(data)
      .sort()
      .map((community) => `${community}:${data[community]!.map((s) => `${s.mode}@${s.ip}`).sort().join(',')}`)
      .join('|');
  }

  private static encodeBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary);
  }

  private static decodeBase64(base64: string): string {
    const binary = atob(base64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new TextDecoder().decode(bytes);
  }
}