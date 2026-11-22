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

  /**
   * 读响应正文；非 2xx 时抛出带状态、Content-Type 与正文片段的错误，
   * 便于识别 WAF 的自定义码（如 456）与挑战页，而不是只留一个数字。
   */
  protected async readText(response: Response): Promise<string> {
    const text = await response.text();

    if (!response.ok) {
      const contentType = response.headers.get('Content-Type') ?? '?';
      throw new Error(`HTTP ${response.status} ${contentType} <- ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
    }

    return text;
  }
}
