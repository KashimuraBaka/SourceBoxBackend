#!/usr/bin/env node
/**
 * 用四个社区数据源刷新仓库根目录的 Servers.json。
 *
 * 流程：读现有 Servers.json 作基线 → 抓活源 → 社区整组替换 → 内容有变化才写回。
 * 写回后按环境变量里的 GitHub token 决定是否提交（GitHub Contents API，不依赖 git/SSH）：
 *   GITHUB_TOKEN / SERVERS_GITHUB_TOKEN / GH_TOKEN —— 依次检测，取第一个非空（与 Worker 变量同名）
 *   仓库/分支读 GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH（与 Worker 变量同名），回退 Actions 变量
 *   有 token → PUT /repos/{owner}/{repo}/contents/Servers.json；无 token → 只写本地文件
 * 参数：--dry 只打印将要提交到哪里（不发 PUT 请求）
 * 由 .github/workflows/update-servers.yml 定时执行（也可本地 npm run sync:servers）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateServers, createSources } from '../src/servers/aggregate';
import type { NormalizedServer } from '../src/servers/types';

interface RawServersJson {
  update_time?: number;
  data?: Record<string, Array<{ mode?: string; ip?: string }>>;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serversPath = resolve(scriptDir, '..', '..', 'Servers.json');
const SERVERS_FILE = 'Servers.json';

function normalize(raw: RawServersJson): Record<string, NormalizedServer[]> {
  const data: Record<string, NormalizedServer[]> = {};

  for (const [community, list] of Object.entries(raw.data ?? {})) {
    data[community] = (list ?? [])
      .filter((item) => typeof item?.ip === 'string' && item.ip.trim().length > 0)
      .map((item) => ({ mode: item.mode?.trim().toLowerCase() || 'cs2', ip: item.ip!.trim() }));
  }

  return data;
}

function signature(data: Record<string, NormalizedServer[]>): string {
  return Object.keys(data)
    .sort()
    .map((community) => `${community}:${data[community]!.map((s) => `${s.mode}@${s.ip}`).sort().join(',')}`)
    .join('|');
}

interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

/** 按顺序检测 token（GITHUB_TOKEN 优先，与 Worker 变量同名），返回 [变量名, 值]。 */
function detectToken(): [string, string] | undefined {
  for (const name of ['GITHUB_TOKEN', 'SERVERS_GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const value = process.env[name]?.trim();

    if (value) {
      return [name, value];
    }
  }

  return undefined;
}

/** 仓库/分支优先读 GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH（与 Worker 变量同名）。 */
function detectRepo(): RepoRef | undefined {
  const full = process.env.GITHUB_REPOSITORY?.trim();
  const [ownerFromRepo, repoFromRepo] = full?.includes('/') ? full.split('/') : [];

  return {
    owner: process.env.GITHUB_OWNER?.trim() || ownerFromRepo || 'KashimuraBaka',
    repo: process.env.GITHUB_REPO?.trim() || repoFromRepo || 'SourceBoxBackend',
    branch: process.env.GITHUB_BRANCH?.trim() || process.env.GITHUB_REF_NAME?.trim() || 'main',
  };
}

/** 用 Contents API 提交（服务端生成 commit，测试环境无需 git/SSH）。 */
async function commitViaApi(repo: RepoRef, token: string, content: string, message: string): Promise<void> {
  const apiBase = process.env.GITHUB_API_URL?.trim() || 'https://api.github.com';
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'SourceBoxBackend-Sync',
  };

  const contentsUrl = `${apiBase}/repos/${repo.owner}/${repo.repo}/contents/${SERVERS_FILE}`;
  const dryRun = process.argv.includes('--dry');

  // --dry 也读一次 sha：能打印「覆盖/新建」，也能提前暴露凭据无效（401）
  const current = await fetch(`${contentsUrl}?ref=${encodeURIComponent(repo.branch)}`, { headers });
  let sha: string | undefined;

  if (current.ok) {
    sha = ((await current.json()) as { sha?: string }).sha;
  } else if (current.status !== 404) {
    throw new Error(`读取远端文件失败：HTTP ${current.status}`);
  }

  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: repo.branch,
    ...(sha ? { sha } : {}),
  };

  if (dryRun) {
    console.log(`[dry] 将提交到 ${repo.owner}/${repo.repo}@${repo.branch}（${sha ? `覆盖 ${sha.slice(0, 7)}` : '新建文件'}）`);
    return;
  }

  const response = await fetch(contentsUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`提交失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  const result = (await response.json()) as { commit?: { sha?: string } };
  console.log(`已提交 ${repo.owner}/${repo.repo}@${repo.branch} commit=${result.commit?.sha?.slice(0, 7) ?? '?'}`);
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(serversPath, 'utf8')) as RawServersJson;
  const baseline = normalize(raw);

  const { servers, sources } = await aggregateServers(createSources(), baseline);

  for (const [community, list] of Object.entries(servers.data)) {
    console.log(`${community.padEnd(8)} ${String(list.length).padStart(3)} 台`);
  }

  if (sources.length > 0) {
    for (const failure of sources) {
      console.warn(`[失败] ${failure.name}: ${failure.error}`);
    }
  }

  const changed = signature(servers.data) !== signature(baseline);
  const token = detectToken();
  const repo = detectRepo();

  if (!changed) {
    console.log('无变化，未写入 Servers.json');
  } else {
    const output: RawServersJson = {
      update_time: Math.floor(Date.now() / 1000),
      data: servers.data,
    };

    await writeFile(serversPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(`已更新 ${serversPath}`);
  }

  if (!token) {
    console.log('未检测到 GitHub token（GITHUB_TOKEN / SERVERS_GITHUB_TOKEN / GH_TOKEN），跳过提交（仅本地文件）');
    return;
  }

  console.log(`检测到凭据：${token[0]}`);

  if (!repo) {
    console.warn('未识别到目标仓库（GITHUB_OWNER + GITHUB_REPO 或 GITHUB_REPOSITORY），跳过提交');
    return;
  }

  const content = await readFile(serversPath, 'utf8');
  await commitViaApi(repo, token[1], content, 'chore(servers): 自动同步四社区服务器列表');
  console.log(`（凭据来源：${token[0]}）`);
}

await main();
