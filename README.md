# SourceBox.Backend

SourceBox 的后端资源仓库（原名 `SourceBoxResource` / `SourceBoxResources`）。
主程序不编译这里的代码，只在运行时从这里拉取配置、服务器列表、发布日志与创意工坊发布模板。

服务基址：`https://resource.sourcebox.kashimura.cn`
仓库：`git@github.com:KashimuraBaka/SourceBoxBackend.git`

## 路径说明

| 路径 | 作用 |
|---|---|
| `Servers.json` | 服务器列表，`{ update_time, data: { 社区: [{ mode, ip }] } }`，按 AppID 无关，客户端直接用 |
| `ReleaseNotes.md` | 更新日志，客户端"更新说明"直接展示 |
| `WorkshopPublishTemplate/{appId}.json` | 创意工坊发布模板，按 AppID 命名（4000 / 480 / 550 / 730 …） |
| `SourceBox.Backend.csproj` | 空项目，仅让该目录参与主解决方案构建 |
| `CloudflareWorker/` | Worker 源码（项目名 `sourceboxapi`），接口、变量与部署见 `wrangler.toml` 和 `src/` |
| `.github/workflows/update-servers.yml` | 每小时 17 分同步 `Servers.json`（也可手动触发） |

## 约定

- `Servers.json`、`ReleaseNotes.md`、`WorkshopPublishTemplate/*.json` 都被客户端直接消费，字段需与主程序模型一致。
- 发布日志按版本从新到旧追加，不删历史；模板按 AppID 新增，不改已有字段名。