/**
 * 全项目共用的唯一 UA。
 *
 * 统一成浏览器 UA，避免每个源各写一份（也避免被风雲社的 WAF 挑战页拦下）。
 * 注意：Node 的全局 WebSocket 无法自定义请求头，moeub 的 Node 分支不带 UA。
 */
export class UserAgent {
  static readonly BROWSER =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
}