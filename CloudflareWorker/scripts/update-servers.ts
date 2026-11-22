#!/usr/bin/env node
/**
 * 用四个社区数据源刷新仓库根目录的 Servers.json。
 *
 * 流程：读现有 Servers.json 作基线 → 抓活源 → 社区整组替换 → 内容有变化才写回。
 * 写回后按环境变量里的 GitHub token 决定是否提交：
 *   SERVERS_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN —— 依次检测，取第一个非空
 *   有 token → 走 GitHub Contents API 直接提交（不依赖 git/SSH）；无 token → 只写本地文件
 * 参数：--dry 只打印将要提交的内容，不发 PUT 请求
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

const SERVERS_FILE = 'Servers.json';

interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

/** 生产环境里按顺序检测 token，返回 [变量名, 值]。 */
function detectToken(): [string, string] | undefined {
  for (const name of ['SERVERS_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const value = process.env[name]?.trim();

    if (value) {
      return [name, value];
    }
  }

  return undefined;
}

/** Actions 里用 GITHUB_REPOSITORY / GITHUB_REF_NAME；本地可用 GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH。 */
function detectRepo(): RepoRef | undefined {
  const branch = process.env.GITHUB_REF_NAME?.trim() || process.env.GITHUB_BRANCH?.trim() || 'main';
  const full = process.env.GITHUB_REPOSITORY?.trim();
  const [ownerFromRepo, repoFromRepo] = full?.includes('/') ? full.split('/') : [];

  return {
    owner: ownerFromRepo || process.env.GITHUB_OWNER?.trim() || 'KashimuraBaka',
    repo: repoFromRepo || process.env.GITHUB_REPO?.trim() || 'SourceBoxBackend',
    branch,
  };
}

/** 用 Contents API 提交，避免依赖 git 凭据（生产环境没有 SSH key）。 */
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

  const current = dryRun ? undefined : await fetch(`${contentsUrl}?ref=${encodeURIComponent(repo.branch)}`, { headers });

  let sha: string | undefined;

  if (current?.ok) {
    const payload = (await current.json()) as { sha?: string };
    sha = payload.sha;
  } else if (current && current.status !== 404) {
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
  const forceCommit = process.argv.includes('--force-commit');
  const token = detectToken();
  const repo = detectRepo();

  if (!changed) {
    console.log('无变化，未写入 Servers.json');
  } else {
    const output: RawServersJson = {
      update_time: Math.floor(Date.now() / 1000),
      data: servers.data,
    };

    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    await writeFile(serversPath, serialized, 'utf8');
    console.log(`已更新 ${serversPath}`);
  }

  console.log(token ? `检测到凭据：${token[0]}` : '未检测到 GitHub token（SERVERS_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN）');

  if (!token) {
    console.log('跳过提交（仅本地文件）');
    return;
  }

  if (!changed && !forceCommit) {
    console.log('内容无变化，跳过提交（--force-commit 可强制）');
    return;
  }

  if (!repo) {
    console.warn('未识别到目标仓库（GITHUB_REPOSITORY 或 GITHUB_OWNER + GITHUB_REPO），跳过提交');
    return;
  }

  const content = await readFile(serversPath, 'utf8');
  await commitViaApi(repo, token[1], content, 'chore(servers): 自动同步四社区服务器列表');
  console.log(`（凭据来源：${token[0]}）`);
}



await main();
