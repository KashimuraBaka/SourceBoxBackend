import { DarkrpSource } from './darkrp';
import { FyscsSource } from './fyscs';
import { MoeubSource } from './moeub';
import type { ServerSource } from '../../types';
import { ZombiedenSource } from './zombieden';

export { DarkrpSource, FyscsSource, MoeubSource, ZombiedenSource };

/** 社区数据源的注册表：顺序即 sources[] 里的诊断顺序。 */
export class ServerSourceRegistry {
  static create(fysUpstreamUrl?: string): ServerSource[] {
    return [new ZombiedenSource(), new DarkrpSource(), new FyscsSource(fysUpstreamUrl), new MoeubSource()];
  }
}