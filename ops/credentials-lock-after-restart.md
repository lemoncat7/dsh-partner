# DSH 重启后凭据写锁超时

2026-10-29 部署伙伴 2.17.0 时，宿主 `@deepseek-ai/dsh-client-connection` 启动失败：`atomic-write: timed out waiting for the writer lock at /data/.credentials.yaml.lock`。

该文件内容为旧进程 PID `7`，修改时间为 `07:48:29Z`，早于容器两次启动时间（`07:50:55Z`、`07:55:32Z`）。容器内新 Node 进程也使用 PID `7`，宿主的锁恢复逻辑将其视为活跃持有者而不能自动回收。

处理前持有生产部署锁，核对容器启动时间、锁修改时间、锁记录及 inode，确认是重启前的旧锁。将该锁原样移动到 `/data/plugin-package-backups/credentials-stale-lock-2170`，不修改凭据文件。正在等待的宿主可以继续获取锁。

不要仅因等待超时就删除写锁；必须先确认真实持有者已经退出，尤其注意容器 PID 重用。健康检查的 HTTP 成功也不足以确认宿主已经完成激活，应同时验证认证入口和伙伴 API。
