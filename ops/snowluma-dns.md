# SnowLuma DNS

如果 QQ 长连接在线，但空间 API 报 `getaddrinfo EAI_AGAIN h5.qzone.qq.com`，检查容器 `/etc/resolv.conf` 的 ExtServers。宿主迁移 Tailscale DNS 后，已创建容器可能仍引用不可达的 `100.100.100.100`。

在现有 Compose 的 `snowluma` 服务增加：

```yaml
dns:
  - 223.5.5.5
  - 119.29.29.29
```

保留网络 `appnet`。先备份 Compose 与容器的 resolv.conf。当前运行容器可先把这两个 DNS 写入 resolv.conf，再保留 `127.0.0.11` 作为 Docker 名称解析后备，避免为了 DNS 强制重登 QQ；下次重建容器时 Docker 内置 DNS 会使用 Compose 指定的上游。

验证只读取 `get_qzone_msg_list`、`get_qzone_feeds` 和 `get_ai_characters`，不发送真实消息或动态。不要在日志中输出 WS Token、Cookies 或签名媒体地址。
