# 2.21.4 工具入口兼容部署来源

目标环境：DSH 0.2.1-rc.2，知识库 2.17.0，SSH 1.14.0。

本包基于已部署的伙伴 2.21.3 源码快照，合入当前工作区的以下兼容文件，保留线上 QQ 修复；不能从尚未合并线上变更的 2.21.1 工作区直接全量覆盖部署。

- `src/execution/operation-tool-access.ts`（替代旧 `knowledge-tool-access.ts`）
- `src/execution/service.ts`
- `src/execution/agent-support.ts`
- `src/collaboration/composition.ts`
- 对应兼容测试、工具入口说明及版本说明

可复现来源保存在本地 `dist/partner-2.21.4-deployed-source.tar.gz`，包含 src、test、scripts、resources、配置和依赖锁；运行包为 `dist/lemoncat7-dsh-partner-2.21.4.tgz`。后续提交发布前应合并该来源与现有工作区，不能通过回退版本丢失 QQ 修复。

部署脚本：`../../dsh-docker/deploy-partner-entry-2214.mjs`。使用共享部署锁，校验基线版本、依赖锁、全部非目标文件一致性；备份后切换，验证失败自动恢复旧包和元数据。测试只使用临时数据，不触及用户知识文档，不连接真实 SSH 主机。

验证脚本：`../../dsh-docker/verify-partner-entry-2214.mjs` 与 `verify-tool-entry-integration.mjs`。容器测试显式使用 TAP reporter，避免 Node 24 默认输出格式变化导致误判。

2026-10-30 正式部署验证完成：源码回归 114/114，安装包容器回归 72/72，跨入口分发 21 次检查通过，四个在线接口均返回 200。最终备份目录：`dsh-docker/backups/partner-entry-2214-RPsc6o`（工作区根目录下）。首次验证因 reporter 格式误判自动回滚，修正验证器后第二次部署成功。未 push 或发布。

后续归档：上述源码已完整合入 main 的 2.21.5，同时保留好感度主动延续与 QQ 会话修复；开发与部署应以当前 main 为准。旧 2.21.1 工作区已备份并快进同步。
