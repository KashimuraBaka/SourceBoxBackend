/**
 * SourceBox 后端 Worker（项目名 sourceboxapi）
 *
 * 客户端（SourceBox 桌面端 ResourceHelper）请求的是三份静态数据：
 *   GET /Servers.json                            服务器列表
 *   GET /ReleaseNotes.md                         发布日志
 *   GET /WorkshopPublishTemplate/{appId}.json    创意工坊发布模板
 *
 * 数据真身放在 SourceBoxBackend 仓库里，Worker 只做「白名单 + 代理 + 边缘缓存」：
 * 仓库更新后无需重新部署 Worker，缓存过期即生效。
 */

import { aggregateServers, createSources } from './servers/aggregate';
import { fetchBaseline } from './servers/baseline';

interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  CACHE_SECONDS: string;
  GITHUB_TOKEN?: string;
  /** /servers 聚合结果缓存秒数（默认 3600 = 1 小时）。 */
  SERVERS_CACHE_SECONDS?: string;
  /** 风雲社上游地址（可选；默认走内置候选，见 src/servers/fyscs.ts）。 */
  FYS_UPSTREAM_URL?: string;
}

const SERVICE_NAME = 'sourceboxapi';
const USER_AGENT = 'SourceBoxBackend/1.0 (+https://resource.sourcebox.kashimura.cn)';

const TEMPLATE_PATH = /^\/WorkshopPublishTemplate\/(\d{1,10})\.json$/;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-None-Match, Content-Type',
  'Access-Control-Expose-Headers': 'ETag, Cache-Control, X-SourceBox-Source',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed', allow: ['GET', 'HEAD', 'OPTIONS'] }, 405);
    }

    if (url.pathname === '/health') {
      return json({
        ok: true,
        service: SERVICE_NAME,
        upstream: {
          owner: env.GITHUB_OWNER,
          repo: env.GITHUB_REPO,
          branch: env.GITHUB_BRANCH,
        },
      });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return json({
        service: SERVICE_NAME,
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
      return serveData(request, env, ctx, 'Servers.json', 'application/json; charset=utf-8');
    }

    if (url.pathname === '/servers' || url.pathname === '/servers.json') {
      return serveServers(request, env, ctx);
    }

    if (url.pathname === '/ReleaseNotes.md') {
      return serveData(request, env, ctx, 'ReleaseNotes.md', 'text/markdown; charset=utf-8');
    }

    const template = TEMPLATE_PATH.exec(url.pathname);
    if (template) {
      const appId = template[1];
      if (!appId) {
        return json({ error: 'bad_request', message: 'appId 缺失' }, 400);
      }

      return serveData(
        request,
        env,
        ctx,
        `WorkshopPublishTemplate/${appId}.json`,
        'application/json; charset=utf-8',
      );
    }

    return json({ error: 'not_found', path: url.pathname }, 404);
  },
} satisfies ExportedHandler<Env>;

/** 代理一份仓库文件：边缘缓存 + ETag 协商 + CORS。 */
async function serveData(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
  contentType: string,
): Promise<Response> {
  const cacheSeconds = Math.max(0, Number.parseInt(env.CACHE_SECONDS ?? '300', 10) || 0);
  const cache = caches.default;
  const cacheKey = new Request(`https://${SERVICE_NAME}.internal/cache/${path}`, { method: 'GET' });

  const cached = await cache.match(cacheKey);

  if (cached) {
    return finalize(request, cached, path, cacheSeconds, 'cache');
  }

  const upstream = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`;
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/markdown, text/plain, */*',
  };

  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }

  let response: Response;

  try {
    response = await fetch(upstream, { headers, cf: { cacheTtl: 60 } } as RequestInit);
  } catch (error) {
    console.error('upstream fetch failed', path, error);
    return json({ error: 'upstream_unreachable', path }, 502);
  }

  if (!response.ok) {
    console.error('upstream status', path, response.status);
    return json({ error: 'upstream_error', path, status: response.status }, 502);
  }

  const body = await response.text();
  const etag = response.headers.get('ETag') ?? `"${hash(body)}"`;

  const stored = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      ETag: etag,
      'Cache-Control': `public, max-age=60, s-maxage=${cacheSeconds}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, stored.clone()));

  return finalize(request, stored, path, cacheSeconds, 'origin');
}

/** 聚合接口：抓三个社区站点 → 归一成 Servers.json 结构 → 边缘缓存。 */
async function serveServers(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // 聚合结果缓存 1 小时：三个社区站点不必被频繁抓取；?fresh=1 可强制回源调试。
  const cacheSeconds = Math.max(0, Number.parseInt(env.SERVERS_CACHE_SECONDS ?? '3600', 10) || 0);
  const clientMaxAge = 300;
  const cache = caches.default;
  const cacheKey = new Request(`https://${SERVICE_NAME}.internal/servers`, { method: 'GET' });
  const fresh = new URL(request.url).searchParams.has('fresh');

  const cached = fresh ? undefined : await cache.match(cacheKey);

  if (cached) {
    return finalize(request, cached, '/servers', cacheSeconds, 'cache', clientMaxAge);
  }

  // 以仓库 Servers.json 为基线：抓到的社区整组替换，抓不到/未覆盖的社区保留基线条目。
  const errors: Array<{ name: string; error: string }> = [];
  let baseline: Awaited<ReturnType<typeof fetchBaseline>>['servers'] = {};

  try {
    const loaded = await fetchBaseline(env.GITHUB_OWNER, env.GITHUB_REPO, env.GITHUB_BRANCH, AbortSignal.timeout(8000));
    baseline = loaded.servers;
  } catch (error) {
    errors.push({
      name: 'Servers.json',
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
  }

  const { servers, sources } = await aggregateServers(createSources(env.FYS_UPSTREAM_URL), baseline);
  const failures = [...errors, ...sources];

  // 只在有失败时才输出 sources：全部成功时不额外占字节。
  const payload = failures.length > 0 ? { ...servers, sources: failures } : servers;
  const body = JSON.stringify(payload, null, 2);

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${clientMaxAge}, s-maxage=${cacheSeconds}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return finalize(request, response, '/servers', cacheSeconds, 'origin', clientMaxAge);
}

/** 统一加上 CORS / 缓存头，并处理 If-None-Match 与 HEAD。 */
function finalize(
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

  for (const [name, value] of Object.entries(CORS_HEADERS)) {
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

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

/** 轻量内容指纹，用于上游未给 ETag 时生成弱校验值。 */
function hash(text: string): string {
  let value = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }

  return `${text.length.toString(16)}-${(value >>> 0).toString(16)}`;
}
