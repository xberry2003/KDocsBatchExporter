# KDocsBatchExporter

面向金山文档（KDocs 365 企业空间）的模块化 Node.js 批量导出工程。

项目正在逐步完成结构化迁移，目标是扫描企业空间目录，并根据文件类型选择直接下载或官方 DOCX 导出链，同时支持失败重试、文件校验、断点恢复和 manifest 记录。

## 当前边界

- 正式工程使用内部模块调用，不依赖已废弃的 RPA 或旧 POC CLI 串联。
- 普通文件保留原格式直接下载。
- AirPage / `.otl` 使用官方 DOCX 导出链。
- 最终任务按目录分批执行，每个目录拥有独立 scan state、manifest 和恢复边界。
- 未完成 Golden A/B 回归前，不运行企业空间全量任务。

## 开发命令

```powershell
npm install
npm test
npm run check
node scripts/cli.js --help
```

## 目录结构

```text
src/auth/       认证状态
src/kdocs/      KDocs API、数据模型和目录扫描
src/airpage/    AirPage API 与 DOCX 导出
src/download/   路由、下载、重试、路径和校验
src/manifest/   JSONL manifest
src/config/     配置
scripts/        CLI 与维护脚本
tests/unit/     无真实账号单元测试
tests/integration/ 真实环境 A/B 回归
```

## 配置

复制 `.env.example` 并通过环境变量提供本地配置。认证信息应放在仓库外部的凭据文件中，再通过 `KDOCS_CREDENTIAL_PATH` 指向该文件。

真实 Cookie、CSRF、Token、浏览器 session、manifest 和导出文件不得提交到 Git。仓库仅包含程序代码、无敏感值的配置示例和单元测试。

当前完成情况见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。
