export function QqConnectionGuide(): JSX.Element {
  return <aside className="dsh-partner-qq-guide" aria-label="QQ 接入说明">
    <strong>先部署 SnowLuma，再连接 QQ</strong>
    <p>按<a href="https://snowluma.github.io/zh/docs/guide/deploy" target="_blank" rel="noopener noreferrer">部署文档</a>安装 SnowLuma 并登录 QQ，然后填写正向 WebSocket（Universal）地址和 WS Access Token。</p>
    <p>正向 WS 同时收发消息，无需填写 HTTP API。</p>
    <p>也可以让 AI 参照文档，协助部署 SnowLuma 并配置 QQ 渠道。</p>
  </aside>
}
