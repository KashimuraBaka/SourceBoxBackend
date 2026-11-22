#!/usr/bin/env node
/**
 * 用四个社区数据源刷新仓库根目录的 Servers.json。
 *
 * 流程：读现有 Servers.json 作基线 → 抓活源 → 社区整组替换 → 内容有变化才写回。
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

  if (signature(servers.data) === signature(baseline)) {
    console.log('无变化，未写入 Servers.json');
    return;
  }

  const output: RawServersJson = {
    update_time: Math.floor(Date.now() / 1000),
    data: servers.data,
  };

  await writeFile(serversPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`已更新 ${serversPath}`);
}

await main();
