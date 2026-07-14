# KDocsBatchExporter

面向金山文档（KDocs 365 企业空间）的模块化 Node.js 批量导出工程。

项目已完成正式交付并进入上线运行阶段。它用于扫描企业空间目录，并根据文件类型选择直接下载或官方 DOCX 导出链，同时支持失败重试、文件校验、断点恢复、manifest 记录和 Golden A/B 回归对比。

## 项目状态

- 当前版本为上线版，可以正式运行；后续只做兼容性修复、可靠性优化和小范围能力增强。
- 正式工程使用内部模块调用，不依赖已废弃的 RPA 或旧 POC CLI 串联。
- 普通文件保留原格式直接下载。
- AirPage / `.otl` 使用官方 DOCX 导出链。
- DBT 特殊文档、表单和未知类型默认进入人工处理队列，不做伪自动化处理。
- 最终任务按目录分批执行，每个目录拥有独立 scan state、manifest 和恢复边界。
- 正式运行前建议先用 `--scan-only` 或小目录样本确认凭据、输出路径、人工处理项和任务状态目录。
- 正式运行时建议按目录分批执行，保留每批任务的 `manifest`、失败清单和审计报告，方便续跑与问题定位。

## 开发命令

```powershell
npm install
npm test
npm run check
node scripts/cli.js --help
```

## CLI 用法

检查本地凭据摘要，输出不会打印 Cookie、CSRF 或 Token：

```powershell
node scripts/cli.js auth --credential-path C:\path\to\wps365.json
```

扫描企业空间目录并写出 JSONL 清单：

```powershell
node scripts/cli.js scan --url "https://365.kdocs.cn/ent/{orgid}/{groupid}" --output state/scans/sample.jsonl
```

执行混合导出任务：

```powershell
node scripts/cli.js export --url "https://365.kdocs.cn/ent/{orgid}/{groupid}" --output output/sample --task-dir state/tasks/sample
```

只生成扫描、路由计划和审计文件，不下载：

```powershell
node scripts/cli.js export --url "https://365.kdocs.cn/ent/{orgid}/{groupid}" --output output/sample --task-dir state/tasks/sample --scan-only
```

重试已有任务中可自动恢复的失败项：

```powershell
node scripts/cli.js retry-failed --task-dir state/tasks/sample
```

## 目录结构

```text
src/auth/       认证状态
src/kdocs/      KDocs API、数据模型和目录扫描
src/airpage/    AirPage API 与 DOCX 导出
src/download/   路由、下载、重试、路径和校验
src/export/     统一扫描、路由、导出、审计和重试编排
src/manifest/   JSONL manifest
src/config/     配置
scripts/        CLI 与维护脚本
tests/unit/     无真实账号单元测试
tests/integration/ 真实环境 A/B 回归
```

## 当前能力

- 目录扫描：解析企业空间 URL，遍历目录树，生成目录与文件清单。
- 类型识别：区分普通 Office/PDF 文件、AirPage 在线文档、DBT 特殊文档、表单和未知类型。
- 下载路由：普通文件走直接下载，`.otl` / AirPage 在线文档走官方 DOCX 导出。
- 结果校验：校验 PDF、DOCX、PPT/PPTX、XLS/XLSX 等文件格式结构。
- 任务恢复：写出 `manifest`、失败清单、人工处理清单和审计报告，已成功且本地校验通过的文件会在续跑时跳过。
- 回归脚本：支持直接下载样本、AirPage 单篇与 50 篇样本的 Golden 对比。
- 维护模式：后续改动以可回归、可恢复、不泄露凭据为基本约束。

## 配置

复制 `.env.example` 并通过环境变量提供本地配置。认证信息应放在仓库外部的凭据文件中，再通过 `KDOCS_CREDENTIAL_PATH` 指向该文件。

真实 Cookie、CSRF、Token、浏览器 session、manifest 和导出文件不得提交到 Git。仓库仅包含程序代码、无敏感值的配置示例和单元测试。

上线状态和维护说明见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。
