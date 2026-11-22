# SourceBox.Backend

SourceBox 的后端资源仓库（原名 `SourceBoxResource` / `SourceBoxResources`）。
主程序不编译这里的代码，只在运行时从这里拉取配置、服务器列表、发布日志与创意工坊发布模板。

服务基址：`https://resource.sourcebox.kashimura.cn`
仓库：`git@github.com:KashimuraBaka/SourceBoxBackend.git`

## 内容与接口

| 文件 | 主程序接口 | 用途 |
|---|---|---|
| `Servers.json` | `GET {基址}/Servers.json` | 服务器列表（来源、名称、地图、标签等） |
| `ReleaseNotes.md` | `GET {基址}/ReleaseNotes.md` | 更新日志，客户端"更新说明"直接展示 |
| `WorkshopPublishTemplate/{appId}.json` | `GET {基址}/WorkshopPublishTemplate/{appId}.json` | 创意工坊发布模板（上传目录、必填字段等），按 AppID 区分 |
| `SourceBox.Resources.csproj` | — | 空项目，仅让该目录参与主解决方案构建 |

## 目录结构

```
SourceBox.Backend/
├── Servers.json                     服务器列表
├── ReleaseNotes.md                  发布日志
├── WorkshopPublishTemplate/         创意工坊发布模板（按 AppID 命名）
│   ├── 4000.json
│   ├── 480.json
│   ├── 550.json
│   └── 730.json
├── SourceBox.Resources.csproj       空项目（名字沿用旧称，见下）
└── README.md
```

## 关于项目文件命名

项目文件仍叫 `SourceBox.Resources.csproj`：上游尚未改名，主仓库 `SourceBox.sln`
引用的是 `SourceBox.Backend\SourceBox.Resources.csproj`。若后续在仓库内改名，需同步更新
主仓库解决方案里的路径与程序集名。

## 修改约定

- `Servers.json`、`ReleaseNotes.md`、`WorkshopPublishTemplate/*.json` 都是客户端直接消费的数据，
  改动需保持字段与主程序 `SourceServersData` / `WorkshopPublishTemplate` 模型一致。
- 发布日志按版本从新到旧追加，不要删除历史条目。
- 模板按 AppID 新增文件，不要改动已有 AppID 的字段名。