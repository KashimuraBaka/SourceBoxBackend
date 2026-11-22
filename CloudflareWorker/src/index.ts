/**
 * SourceBox 后端 Worker（项目名 sourceboxapi）
 *
 * 静态数据（仓库文件代理）：
 *   GET /Servers.json                            服务器列表
 *   GET /ReleaseNotes.md                         发布日志
 *   GET /WorkshopPublishTemplate/{appId}.json    创意工坊发布模板
 *
 * 聚合接口：
 *   GET /servers | /servers.json                 四社区实时聚合（缓存 1 小时，刷新时异步回写仓库）
 */
import { ServerAggregator } from './servers/aggregate';
import { BaselineLoader } from './servers/baseline';
import { ServersPublisher } from './servers/publish';
import { ServerSourceRegistry } from './servers/sources';
import { UserAgent } from './servers/ua';
import type { Env, NormalizedServers, SourceError } from './types';

class WorkerApp {
  private static readonly SERVICE_NAME = 'sourceboxapi';
  private static readonly TEMPLATE_PATH = /^\/WorkshopPublishTemplate\/(\d{1,10})\.json$/;
  private static readonly CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'If-None-Match, Content-Type',
    'Access-Control-Expose-Headers': 'ETag, Cache-Control, X-SourceBox-Source',
  };

  constructor(
    private readonly env: Env,
    private readonly ctx: ExecutionContext,
  ) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: WorkerApp.CORS_HEADERS });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return WorkerApp.json({ error: 'method_not_allowed', allow: ['GET', 'HEAD', 'OPTIONS'] }, 405);
    }

    if (url.pathname === '/health') {
      return WorkerApp.json({
        ok: true,
        service: WorkerApp.SERVICE_NAME,
        upstream: {
          owner: this.env.GITHUB_OWNER,
          repo: this.env.GITHUB_REPO,
          branch: this.env.GITHUB_BRANCH,
        },
      });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return WorkerApp.json({
        service: WorkerApp.SERVICE_NAME,
        endpoints: [
          'GET /Servers.json',
          'GET /ReleaseNotes.md',
          'GET /WorkshopPublishTemplate/{appId}.json',
          'GET /servers  聚合各社区服务器列表（Servers.json 结构）',
          'GET /health',
        ],
      });
    }

    if (url.pathname === '/Servers.json') {
      return this.serveData(request, 'Servers.json', 'application/json; charset=utf-8');
    }

    if (url.pathname === '/servers' || url.pathname === '/servers.json') {
      return this.serveServers(request);
    }

    if (url.pathname === '/ReleaseNotes.md') {
      return this.serveData(request, 'ReleaseNotes.md', 'text/markdown; charset=utf-8');
    }

    const template = WorkerApp.TEMPLATE_PATH.exec(url.pathname);

    if (template) {
      const appId = template[1];

      if (!appId) {
        return WorkerApp.json({ error: 'bad_request', message: 'appId 缺失' }, 400);
      }

      return this.serveData(request, `WorkshopPublishTemplate/${appId}.json`, 'application/json; charset=utf-8');
    }

    return WorkerApp.json({ error: 'not_found', path: url.pathname }, 404);
  }

  /** 代理一份仓库文件：边缘缓存 + ETag 协商 + CORS。 */
  private async serveData(request: Request, path: string, contentType: string): Promise<Response> {
    const cacheSeconds = Math.max(0, Number.parseInt(this.env.CACHE_SECONDS ?? '300', 10) || 0);
    const cache = caches.default;
    const cacheKey = new Request(`https://${WorkerApp.SERVICE_NAME}.internal/cache/${path}`, { method: 'GET' });

    const cached = await cache.match(cacheKey);

    if (cached) {
      return this.finalize(request, cached, path, cacheSeconds, 'cache');
    }

    const upstream = `https://raw.githubusercontent.com/${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}/${this.env.GITHUB_BRANCH}/${path}`;
    const headers: Record<string, string> = {
      'User-Agent': UserAgent.BROWSER,
      Accept: 'application/json, text/markdown, text/plain, */*',
    };

    if (this.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${this.env.GITHUB_TOKEN}`;
    }

    let response: Response;

    try {
      response = await fetch(upstream, { headers, cf: { cacheTtl: 60 } } as RequestInit);
    } catch (error) {
      console.error('upstream fetch failed', path, error);
      return WorkerApp.json({ error: 'upstream_unreachable', path }, 502);
    }

    if (!response.ok) {
      console.error('upstream status', path, response.status);
      return WorkerApp.json({ error: 'upstream_error', path, status: response.status }, 502);
    }

    const body = await response.text();
    const etag = response.headers.get('ETag') ?? `"${WorkerApp.hash(body)}"`;

    const stored = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        ETag: etag,
        'Cache-Control': `public, max-age=60, s-maxage=${cacheSeconds}`,
      },
    });

    this.ctx.waitUntil(cache.put(cacheKey, stored.clone()));

    return this.finalize(request, stored, path, cacheSeconds, 'origin');
  }

  /** 聚合接口：抓四个社区 → 归一成 Servers.json 结构 → 边缘缓存 → 异步回写仓库。 */
  private async serveServers(request: Request): Promise<Response> {
    const cacheSeconds = Math.max(0, Number.parseInt(this.env.SERVERS_CACHE_SECONDS ?? '3600', 10) || 0);
    const clientMaxAge = 300;
    const cache = caches.default;
    const cacheKey = new Request(`https://${WorkerApp.SERVICE_NAME}.internal/servers`, { method: 'GET' });
    const fresh = new URL(request.url).searchParams.has('fresh');

    const cached = fresh ? undefined : await cache.match(cacheKey);

    if (cached) {
      return this.finalize(request, cached, '/servers', cacheSeconds, 'cache', clientMaxAge);
    }

    // 以仓库 Servers.json 为基线：抓到的社区整组替换，抓不到/未覆盖的社区保留基线条目。
    const errors: SourceError[] = [];
    let baseline: NormalizedServers['data'] = {};

    try {
      const loaded = await new BaselineLoader().load(
        this.env.GITHUB_OWNER,
        this.env.GITHUB_REPO,
        this.env.GITHUB_BRANCH,
        AbortSignal.timeout(8000),
      );
      baseline = loaded.servers;
    } catch (error) {
      errors.push({
        name: 'Servers.json',
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      });
    }

    const aggregator = new ServerAggregator(ServerSourceRegistry.create(this.env.FYS_UPSTREAM_URL));
    const { servers, sources } = await aggregator.collect(baseline);
    const failures = [...errors, ...sources];

    // 缓存刷新时异步回写仓库 Servers.json：不阻塞本次响应，内容没变就跳过，失败只记日志。
    this.ctx.waitUntil(
      new ServersPublisher(this.env)
        .publish(servers)
        .then((result) => {
          if (result !== 'unchanged' && result !== 'skipped-no-token') {
            console.log('[servers] 回写仓库', result);
          }
        })
        .catch((error: unknown) => {
          console.error('[servers] 回写失败', error instanceof Error ? error.message : String(error));
        }),
    );

    // 只在有失败时才输出 sources：全部成功时不额外占字节。
    const payload = failures.length > 0 ? { ...servers, sources: failures } : servers;

    const response = new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${clientMaxAge}, s-maxage=${cacheSeconds}`,
      },
    });

    this.ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return this.finalize(request, response, '/servers', cacheSeconds, 'origin', clientMaxAge);
  }

  /** 统一加上 CORS / 缓存头，并处理 If-None-Match 与 HEAD。 */
  private finalize(
    request: Request,
    response: Response,
    path: string,
    cacheSeconds: number,
    source: 'cache' | 'origin',
    clientMaxAge = 60,
  ): Response {
    const headers = new Headers(response.headers);

    headers.set('Content-Type', headers.get('Content-Type') ?? 'application/octet-stream');
    headers.set('Cache-Control', `public, max-age=${clientMaxAge}, s-maxage=${cacheSeconds}`);
    headers.set('X-SourceBox-Source', source);
    headers.set('X-SourceBox-Path', path);

    for (const [name, value] of Object.entries(WorkerApp.CORS_HEADERS)) {
      headers.set(name, value);
    }

    const etag = headers.get('ETag');

    if (etag && request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers });
    }

    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }

    return new Response(response.body, { status: 200, headers });
  }

  private static json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload, null, 2), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...WorkerApp.CORS_HEADERS,
      },
    });
  }

  /** 轻量内容指纹，用于上游未给 ETag 时生成弱校验值。 */
  private static hash(text: string): string {
    let value = 0x811c9dc5;

    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 0x01000193);
    }

    return `${text.length.toString(16)}-${(value >>> 0).toString(16)}`;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return await new WorkerApp(env, ctx).handle(request);
  },
} satisfies ExportedHandler<Env>;