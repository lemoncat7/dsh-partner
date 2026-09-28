# 生成、等待、恢复与交付

## 提交前

调用 `viora_models_list` 获取当前模型标识、能力和点数价格。逐项检查参考图数量、时长、画幅、分辨率、关键帧支持情况。不要因上次能生成 10 秒就保证 18 秒可用，也不要看到一次 400 就永久把模型上限改为 10 秒。

当前实现还有额外约束：图片 prompt 最多 1024 字符，视频最多 4000；Grok/openai-video 适配器只接受 480p/720p、正整数秒、最多 7 张参考，拒绝 keyframes。Agnes Video 2.5 系列为 4–12 秒；Flash 分辨率限 720p。服务端更新后以工具返回的校验结果及实际模型契约为准。

`viora_generation_submit` 需要 projectId、已有匹配生成 nodeId、kind、完整 prompt、requestId；按需要填 model、inputUrls、parameters。允许的参数是 size、quality、background、seconds、resolution、aspect_ratio、reference_mode、seed、negative_prompt；适配器不保证支持每个字段，尤其不能承诺 negative_prompt 一定传到上游。

requestId 为 8–128 位字母/数字/下划线/短横线，代表一次确定的生成意图。提交前记录它和参数；返回后立即记录 jobId、resultNodeId、canvasSync。不把申请节点 ID 当作生成提交。

## 等待与恢复

- queued/running：查询同一 jobId，不创建同内容的新任务；短检查至少间隔 2 秒，退避而非忙轮询。
- 在伙伴里长时间等待：只有获得 jobId 后才调用可用的 `partner_schedule defer`，check 写 `viora_generation_get` 核验同一 ID，completion 只写这项任务的真实完成条件。看板任务要带 boardTaskId，唤醒只检查并 resolve，后续由看板恢复原任务。
- 没有续接工具：保存 jobId 与恢复方法，明确还在运行，不能承诺离线后仍自动同步。不要用 sleep 或周期任务无限等待。
- 最终检查保持 generation_get 的 syncCanvas=true；仅 syncCanvas=false 不会回填。检查到 succeeded 后确认结果和同步状态；failed 则保留实际原因，不把失败节点写成已完成。
- canvasSync=pending：已有生成仍有效，使用 `viora_generation_sync(jobId)` 修复关联；只有确需补建缺失卡片才传 createMissing=true。不要再生成一次。
- 当前 generation_sync 的 schema 只有 jobId、createMissing；参考修复由服务内部执行，不传未暴露的 repairReferences 字段。
- 409：区分画布版本冲突与 requestId 参数冲突。前者读最新合并；后者核对原意图，不能靠随机换 ID 盲试。
- HTTP 400/422：先看具体错误，核对参数、参考素材、内容限制。改变参数后提交属于新意图，先确认预算和原任务状态。401/403 交由配置负责人处理，不修改密钥绕过。
- 网络超时/断线：有 jobId 就查询；没有 jobId，用原 requestId 和完全相同参数恢复提交回执。不能保证上游恰好一次扣费；不确定时停下核实。
- 服务重启后查询已有任务，不能一律重提。终态失败但上游可能已接受时先核对产出，不自动重复付费。

每个依赖的输入确认成功且可读后再启动下游。并发只限互不依赖且预算允许的镜头；不同时修改同一画布版本，不让多个伙伴争抢同一节点。

## 原图、视频与渠道交付

1. `viora_asset_get` 使用 jobId 或 assetId 二选一。内联图片只是预览，不代表本地已保存；视频也不会自动落到客户端目录。
2. 用返回的短时 `download.url` 下载到当前会话工作目录，使用 suggestedFilename 并避免覆盖；下载 URL 不需要长期 Bearer Token，不把它公开或存进永久台账。
3. 用本地文件工具确认文件存在、大小与类型符合预期，再调用可用的 `partner_send_attachment(path)`。没有本地下载能力时明确限制，不编造路径或称附件已发送。
4. 读取工具回执：sent 才代表渠道已发送；failed 用原 deliveryId 重试，不能重新生成；none 表示仅显示在会话。来源不明的旧预约不自行选最近渠道补发。
5. 链接过期重新 asset_get，不重新生成。最终汇报镜头/产物清单、关键结论和待处理项，不把每次检查、预约完成或原始报错发到渠道。

当前 MCP 不提供 TTS 生成、剪辑合片、删除或管理员配置工具。可创建对应 kind 的节点不代表这些能力已经开放。
