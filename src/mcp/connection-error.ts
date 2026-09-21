/** Classify transport diagnostics without publishing stderr, arguments or credentials. */
export function mcpConnectionError(error: unknown, stderr: string): Error {
  const diagnostic = `${error instanceof Error ? error.message : ''}\n${stderr}`
  let reason = '服务未完成 MCP 握手，请检查服务日志、地址和启动配置'
  if (/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(diagnostic)) {
    reason = 'MCP 启动失败：运行依赖缺失或 npx 缓存不完整，请重新安装该命令的依赖后重试；不是配置 JSON 格式错误'
  } else if (/Non-HTTPS URLs are only allowed/i.test(diagnostic)) {
    reason = 'MCP 启动受限：mcp-remote 拒绝非本机 HTTP 地址；信任该地址时，请在 args 中添加 --allow-http，或使用 HTTPS'
  } else if (/401|403|Unauthorized|Forbidden/i.test(diagnostic)) {
    reason = 'MCP 认证失败或无访问权限，请检查令牌和 Authorization 请求头'
  } else if (/ENOENT|command not found/i.test(diagnostic)) {
    reason = 'MCP 启动命令或工作目录不存在，请检查服务运行环境中的 command、PATH 和 cwd'
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(diagnostic)) {
    reason = 'MCP 地址无法解析，请检查服务运行环境的 DNS 和 Docker 网络'
  } else if (/ECONNREFUSED/i.test(diagnostic)) {
    reason = 'MCP 连接被拒绝，请检查服务是否启动及端口是否正确'
  } else if (/certificate|CERT_|SELF_SIGNED/i.test(diagnostic)) {
    reason = 'MCP TLS 证书校验失败，请检查证书链和信任配置'
  } else if (/timeout|timed out/i.test(diagnostic)) {
    reason = 'MCP 连接超时，请检查服务响应；npx 首次启动还需要下载依赖，请检查 npm 网络或代理'
  }
  return Error(reason.startsWith('MCP ') ? reason : `MCP 连接失败：${reason}`)
}
