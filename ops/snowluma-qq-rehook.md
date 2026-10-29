# QQ 重启后恢复 SnowLuma 桥接

2026-10-29 检查发现：QQ 主进程已更换，SnowLuma 仍为旧进程，3001 未监听，伙伴持续重连。Supervisor 的恢复监听器错误地发送 `RESULT\n2\nOK`；协议实际要求 `RESULT 2\nOK`。Supervisor 会把错误应答的监听器置为 UNKNOWN，进程虽然显示 RUNNING，但不再接收事件。

修正脚本见同目录 `snowluma-qq-rehook.py`。已部署到 `/volume3/docker/snowluma/ops/snowluma-qq-rehook.py` 和当前容器 `/app/ops/snowluma-qq-rehook.py`，随后重启 `qq-bridge-recovery`。现有 Compose 配置了前者到后者的只读挂载，但当前容器尚未重建，因此必须同时更新容器内副本。

恢复业务只重启了 `snowluma` 桥接进程，未重启 QQ 或发送聊天消息。验证 3001 监听，并只读调用 `get_ai_characters`（30 个音色）、`get_qzone_msg_list`、`get_qzone_feeds`。测试覆盖连续事件应答和过时 PID 不重启桥接。
