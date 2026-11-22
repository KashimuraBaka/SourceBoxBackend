/**
 * 把各社区五花八门的服务器名/分组名归一成 Servers.json 里的短 mode。
 * 现有基线里的取值：ze / mg / kz / surf / bhop / de / ar / hns / afk。
 *
 * 注意顺序：越具体的玩法越靠前，避免「僵尸乐园」这类社区前缀把整组误判成 ze。
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bbhop\b|连跳|bunny\s*hop/iu, 'bhop'],
  [/\bsurf\b|滑翔/iu, 'surf'],
  [/\bkz\b|\bclimb\b|攀岩/iu, 'kz'],
  [/\bmg\b|minigame|娱乐闯关|迷你游戏|小游戏|闯关/iu, 'mg'],
  [/\bze\b|zombie\s*escape|僵尸逃跑|僵尸模式|逃跑/iu, 'ze'],
  [/生化模式|生化|\bzm\b|zombie\s*mod/iu, 'zm'],
  [/\bhns\b|躲猫猫|hide\s*(and|&)\s*seek|prop\s*hunt/iu, 'hns'],
  [/\bttt\b|叛徒/iu, 'ttt'],
  [/\bjail\b|越狱/iu, 'jail'],
  [/挂机|afk|idle|休闲大厅|饰品检视|检视/iu, 'afk'],
  [/\bde\b|竞技|排位|competitive|casual|混战|对抗|pve|pvp/iu, 'ar'],
];

/** 去掉社区名、装饰括号和地图前缀，避免干扰关键词判断。 */
function normalize(text: string): string {
  return text
    .replace(/【[^】]*】/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/僵尸乐园|风云社|風雲社|exg/giu, ' ')
    .replace(/\s+/g, ' ');
}

export function deriveMode(...hints: Array<string | undefined | null>): string {
  const text = normalize(
    hints.filter((hint): hint is string => typeof hint === 'string' && hint.length > 0).join(' '),
  ).trim();

  if (!text) {
    return 'cs2';
  }

  for (const [pattern, mode] of RULES) {
    if (pattern.test(text)) {
      return mode;
    }
  }

  return 'cs2';
}

/** 显式指定优先（例如上游自带 mode 字段时），否则按关键词推断。 */
export function pickMode(explicit: string | undefined, ...hints: Array<string | undefined | null>): string {
  const trimmed = explicit?.trim().toLowerCase();

  // 只接受像玩法缩写的东西；"cs2" 这类是游戏分类，不是模式。
  if (trimmed && /^[a-z0-9]{2,8}$/.test(trimmed) && trimmed !== 'cs2') {
    return trimmed;
  }

  return deriveMode(...hints);
}

/**
 * 按「优先级顺序」逐个候选判断：先看具体服务器名，再看分组名/地图。
 * 这样「CS2 SURF #2」不会被分组名里的 BHOP 抢走。
 */
export function deriveModePrefer(...candidates: Array<string | undefined | null>): string {
  for (const candidate of candidates) {
    const mode = deriveMode(candidate);

    if (mode !== 'cs2') {
      return mode;
    }
  }

  return 'cs2';
}
