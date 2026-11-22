import type { NormalizedServer, ServerSource } from '../../types';

/**
 * 所有社区数据源的基类：统一 name/community/fetchRaw/parse 的形状。
 * 各社区自己的 mode 判定规则写在各自的类里，基类不参与。
 */
export abstract class ServerSourceBase implements ServerSource {
  abstract readonly name: string;
  abstract readonly community: string;

  /** 取原始载荷：HTTP 源返回正文文本，WebSocket 源返回收到的消息文本数组。 */
  abstract fetchRaw(signal: AbortSignal): Promise<unknown>;

  /** 解析原始载荷；结构不符或为空时抛错，由聚合层记录到 sources。 */
  abstract parse(raw: unknown): NormalizedServer[];
}
