# CloudflareWorker（sourceboxapi）

SourceBox 客户端的后端 Worker：把仓库里的三份静态数据以 HTTP 接口暴露出来，带白名单、边缘缓存与 ETag。

服务基址：`https://resource.sourcebox.kashimura.cn`（自定义域名，在 Dashboard → Triggers → Custom Domains 绑定）
上游数据仓库：`KashimuraBaka/SourceBoxBackend`（即本子模块）

## 面板配置对照

| Cloudflare 面板项 | 值 |
|---|---|
| 仓库 | `KashimuraBaka/SourceBoxAPI` |
| 项目名称 | `sourceboxapi`（= `wrangler.toml` 的 `name`） |
| 构建命令 | 空（本目录无需构建步骤，wrangler 自己打包 TS） |
| 部署命令 | `npx wrangler deploy` |
| 预览命令 | `npx wrangler preview`（见下方说明） |
| 启用预览构建 | 开 |
| 使用 Cloudflare Access 保护 | 关（客户端是桌面程序，走 HTTP 拉取，无浏览器登录态） |

> **预览命令说明**：`wrangler preview` 在 wrangler 3 已移除。面板里保留原值不会影响部署；
> 真正要发预览版本请用 `npx wrangler versions upload`（本仓库脚本 `npm run preview:upload`）。

## 接口

| 路由 | 上游文件 | Content-Type |
|---|---|---|
| `GET /Servers.json` | `Servers.json` | `application/json; charset=utf-8` |
| `GET /ReleaseNotes.md` | `ReleaseNotes.md` | `text/markdown; charset=utf-8` |
| `GET /WorkshopPublishTemplate/{appId}.json` | `WorkshopPublishTemplate/{appId}.json`（`appId` 限 1–10 位数字） | `application/json; charset=utf-8` |
| `GET /health` | — | 服务名与上游配置 |
| `GET /` | — | 路由清单 |

行为约定：

- 只接受 `GET` / `HEAD` / `OPTIONS`，其余 `405`；未知路径 `404`（JSON）。
- 上游取 `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`，`owner/repo/branch` 来自 `[vars]`。
- 首次请求回源，之后命中 `caches.default`；`CACHE_SECONDS`（默认 300）控制边缘缓存时长。
- 响应带 `ETag`，客户端带 `If-None-Match` 时返回 `304`；`Cache-Control: public, max-age=60, s-maxage=<CACHE_SECONDS>`。
- 已带 CORS 头，浏览器直连也不会被挡。
- 仓库内容更新后**不需要重新部署 Worker**，缓存过期即生效。

## 目录结构

```
CloudflareWorker/
├── src/index.ts         Worker 入口（路由 + 代理 + 缓存）
├── wrangler.toml        Worker 名称 / 兼容日期 / 变量 / 可观测性
├── package.json         脚本与开发依赖（wrangler / typescript / workers-types）
├── tsconfig.json        strict 类型检查
├── .gitignore           node_modules、.wrangler、.dev.vars
└── README.md
```


### 服务器聚合 `/servers`

客户端 `ResourceHelper.GetServers` 拉的是静态 `Servers.json`；需要实时数据时改用 `/servers`
（或 `/servers.json`），它现场抓三个社区站点再归一成同一结构：

| 上游 | 抓取地址 | 状态 |
|---|---|---|
| 僵尸乐园 | `https://s.zombieden.cn/api/open/servers`（Nuxt 公开接口，按玩法分组） | 可用，18 台 |
| ExG 社区 | `https://list.darkrp.cn:9000/ServerList/CurrentStatus`（门户 SPA 实际调用的接口，`text/plain` 里是 JSON 数组） | 可用，18 台 |
| 风雲社 | `https://fyscs.cn/silverwing/system/dashboard`（需 `X-Client: swallowtail` + 浏览器 UA） | 可用，16 台（仅 cs2） |
| UB 社区 | `wss://ws2.moeub.cn/ws?files=0&appid=730`（WebSocket 推送 `server/init`，无 REST 列表） | 可用，45 台 |

风雲社的两道门槛（实测）：

1. **客户端标识**：接口要求 `X-Client: swallowtail`（+ `X-Request: XMLHTTPRequest`），否则 400 `Invalid Client<>!`；
   这个值来自站点前端 axios 拦截器。
2. **WAF 的 UA 判定**：站点前面有 `/_guard/html.js?js=delay_jump_html` 挑战页。UAA 矩阵实测：
   `SourceBoxBackend/1.0` → 挑战页；`Mozilla/5.0 (compatible; …)` → 挑战页；完整 Chrome UA → 正常 JSON。
   因此适配器对该源使用浏览器 UA；`FYS_UPSTREAM_URL` 仍可覆盖上游地址。

（顺带记录挑战算法：`guard` cookie 前三 8 位作 RC4 key、末两位十进制数 `n`，
`guardret = base64(rc4(String(n*2+15), key))`；UA 达标时用不到，留作备用。）

归一规则：

- `update_time`：抓取时刻（epoch 秒）。
- `data`：**以仓库 `Servers.json` 为基线**——活源抓到的社区整组替换，活源失败或没有活源的社区（`X社区`、`国外社区`）保留基线条目；
  每项只有 `mode` + `ip`，与 `Servers.json` 完全一致。社区键对齐基线：`僵尸乐园` / `EXG` / `MOEUB` / `风云社` / `X社区` / `国外社区`。
- `mode` 由服务器名优先、其次分组名/地图关键词推断：`ze / mg / kz / surf / bhop / hns / ttt / jail / afk / ar`，
  社区前缀（`【僵尸乐园】` 等）会先被剥掉，避免整组误判成 `ze`。
- 同一源内按 `ip` 去重，按 `mode`、`ip` 排序。
- 每个上游独立 9 秒超时，失败只影响自己那一组，不影响整体返回。
- UB 社区走 WebSocket：连上后逐条推 `server/init`，采集到「最后一条后再静默 800ms」或「5s 硬上限」即关闭；心跳/update 不重置静默计时。
- 基线抓取失败时只返回活数据，并把 `Servers.json` 记为一条失败；单个活源失败时该社区回落到基线。
- **`sources` 只在有上游抓取失败时出现**，内容只含失败项（`{ name, error }`）；全部成功时该字段完全不输出，不占字节。
- 结果整体缓存 **1 小时**（`SERVERS_CACHE_SECONDS`，默认 `3600`，`s-maxage` 生效），客户端 `max-age=300`；
  调试可用 `/servers?fresh=1` 强制回源。三个社区站点因此不会被频繁抓取。

响应示例（全部成功时只有两个字段）：

```json
{
  "update_time": 1795321200,
  "data": {
    "僵尸乐园": [ { "mode": "ze", "ip": "cs1.zombieden.cn:27016" } ],
    "EXG":      [ { "mode": "afk", "ip": "202.189.10.19:27001" } ],
    "风云社":   [ { "mode": "ze", "ip": "s1.cs2ze.com:27015" } ]
  }
}
```

有上游失败时才多出 `sources`，且只列失败项：

```json
{
  "update_time": 1795321200,
  "data": { "僵尸乐园": [], "EXG": [] },
  "sources": [ { "name": "fyscs.cn", "error": "HTTP 200 text/html 非 JSON: <script src=\"/_guard/html.js?...\" />" } ]
}
```
### Servers.json 自动同步

`npm run sync:servers`（`scripts/update-servers.ts`）把四个活源的结果写回仓库根目录的 `Servers.json`：

1. 读现有 `Servers.json` 作基线；
2. 抓四个社区（僵尸乐园 / EXG / 风雲社 / MOEUB）；
3. 抓到的社区整组替换，抓不到或没有活源的社区（X社区 / 国外社区）保留基线条目；
4. 只有内容（忽略 `update_time`）变化时才写回，`update_time` 取当前秒级时间戳。

自动化：`.github/workflows/update-servers.yml` 每小时 17 分执行（也支持手动 `workflow_dispatch`），
有变化时以 `github-actions[bot]` 提交并推送，提交信息为 `chore(servers): 自动同步四社区服务器列表`。

本地手动同步：

```bash
cd CloudflareWorker
npm run sync:servers
```
## 本地开发与测试

```bash
npm install
npm run typecheck     # tsc --noEmit，0 错误
npm run dev           # http://127.0.0.1:51789
```

端口固定为 **51789**（5 位数、非主流服务端口）。不要用 `8788` 之类常见端口——本机已有其它服务
（pythonw 网关）监听 8788，占用会互相串请求。

实测（`wrangler dev`，2026-11-22）：

| 请求 | 结果 |
|---|---|
| `GET /health` | `200`，`{"ok":true,"service":"sourceboxapi",...}` |
| `GET /` | `200`，路由清单 |
| `GET /Servers.json` | `200`，真实服务器列表 JSON（含 `zombieden` 等条目） |
| `GET /ReleaseNotes.md` | `200`，`## 1.0.10.10 ~ 1.0.10.12 ...` |
| `GET /WorkshopPublishTemplate/730.json` | `200` |
| `GET /WorkshopPublishTemplate/abc.json` | `404`（非数字 appId） |
| `GET /Unknown.json` | `404` |
| `POST /Servers.json` | `405` |
| `HEAD /Servers.json` | `200`，无 body、带 `ETag` |
| `GET /Servers.json` + `If-None-Match` | `304` |
| `GET /servers` | `200`，六个社区合计 **116 台**（僵尸乐园 18 / EXG 19 / MOEUB 45 / 风云社 16 来自活源，X社区 6 / 国外社区 12 来自基线）；全部成功时无 `sources` 字段 |
| 单源失败回落 | 临时把 `FYS_UPSTREAM_URL` 指向不可达地址：`sources` 只列 `fyscs.cn`，`风云社` 自动回落到基线 20 台，其它社区不受影响 |
| `GET /servers?fresh=1` | `200`，绕过缓存重新抓取（实测 ~1.0 s，四源并行，含 WebSocket 采集）；响应头 `s-maxage=3600` |
| `GET /servers`（第二次） | `200`，`X-SourceBox-Source: cache`，5 ms，不再打上游 |
| 模式归一 | 僵尸乐园 `ze5 / mg2 / kz3 / surf2 / bhop2 / ar3 / afk1`；EXG `ze10 / surf2 / mg1 / hns2 / afk3` |

## 部署

```bash
npm run deploy        # = npx wrangler deploy
```

首次部署前：

1. `npx wrangler login`（本机登录）或设置 `CLOUDFLARE_API_TOKEN`。
2. 私有仓库或需要提高 GitHub 速率限制时：`npx wrangler secret put GITHUB_TOKEN`。
3. Dashboard → Workers → `sourceboxapi` → Triggers → Custom Domains 绑定 `resource.sourcebox.kashimura.cn`
   （或在 `wrangler.toml` 里解开 `routes` 注释走 Route 方式）。

## 变量

| 变量 | 位置 | 说明 |
|---|---|---|
| `GITHUB_OWNER` | `[vars]` | 上游仓库 owner，默认 `KashimuraBaka` |
| `GITHUB_REPO` | `[vars]` | 上游仓库名，默认 `SourceBoxBackend` |
| `GITHUB_BRANCH` | `[vars]` | 上游分支，默认 `main` |
| `CACHE_SECONDS` | `[vars]` | 仓库静态文件（Servers.json / ReleaseNotes.md / 模板）缓存时长，默认 `300` |
| `SERVERS_CACHE_SECONDS` | `[vars]` | `/servers` 聚合结果缓存时长，默认 `3600`（1 小时） |
| `GITHUB_TOKEN` | secret | 可选，私有仓库或提权用 |
