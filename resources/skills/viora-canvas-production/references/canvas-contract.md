# MCP 节点与引用契约

依据本仓库 `api/src/mcp/{canvas-tools,generation-tools,generation-canvas,reference-inputs}.ts`。运行时以实际 tools/list schema 为准，不依据旧示例猜字段。

## 读取和写入

1. `viora_projects_list` 找已有项目，必要且获授权时 `viora_project_create`。项目创建不是幂等的；响应丢失先查询项目。
2. `viora_canvas_read(projectId, offset, limit)` 返回 version，以及独立分页的 nodes/links。分别跟随 nextOffset；多个分页版本不同就重新读取相关快照再修改。
3. `viora_canvas_allocate_ids(projectId, count)` 返回 start，使用分配范围内的 ID。C01/S01 等创作编号放标题/说明中，不冒充数值 ID。
4. `viora_canvas_apply` 传 projectId、baseVersion、batchId、nodes、links，每次 nodes/links 各最多 100。相同网络重试保持整个批次相同；409 后重新读取、合并，再用新 batchId。节点是完整记录，更新前保留原有所有非目标字段。

每个节点必填 id、kind、x、y、width、height、title、body、accent；width/height 为正数。使用已有节点配色，不额外改主题。

## 创作概念如何落地

| 内容 | kind / 字段 | 说明 |
| --- | --- | --- |
| 简报、人物设定、镜头清单 | note 或 prompt；title/body | 只是文字，未生成图片 |
| 人物/场景/分镜图 | image；生成后 mediaUrl/jobId | 实际参考必须有可读取媒体 |
| 视频生成配置 | video，无结果 mediaUrl/jobId | 作为 generation_submit 的 nodeId |
| 视频生成结果 | 工具返回 resultNodeId | 系统创建独立结果节点，role=result |

图片首次生成可能直接回填原 image 节点；已有结果再次生成可能创建独立节点。始终以返回 resultNodeId 为准，不假定每次都产生同一种结构。

推荐逻辑关系：

```text
人物基准图 ─┐
            ├─→ 分镜 image 节点（显式生成并验收）
场景基准图 ─┘                 │
                              └─→ video 生成节点 ─→ video 结果节点
```

连线字段：from、to、fromSide、toSide，可用 top/right/bottom/left。参考图输入顺序通过从 0 开始的 inputOrder 明确指定；顺序不是人物编号或时间帧序。

不要把人物/场景直接连到视频结果节点；不要拿 role=result、带结果 mediaUrl/jobId 的视频卡片重新提交生成。

## 实际参考输入

- 从认可 image 节点的 mediaUrl 或同项目资产获取真实引用；不要用缩略图、短时 download.url、本地路径或 sandbox 地址当持久参考。
- 视频 inputUrls 与生成卡片已连接的所有 image 输入数量、身份、顺序完全一致。显式设置 inputOrder，避免依赖坐标排序。连了但尚未生成、没有 mediaUrl 的图不能作为输入。
- 没有参考连线时可以显式传入实际素材，由同步逻辑补建；为了可审查，优先在提交前把关系建清楚。
- 图片也显式传 inputUrls；不能认为连线会自动把参考图送给模型。
- 人物说明等文字节点不会自动变成完整 prompt。提交时自行组装，并在台账中记录本次实际 prompt。

## 布局与修订

在空白区域采用一致卡片宽度和行距，人物/场景在左、镜头从上到下、视频结果在右，留出结果卡片空间。先读已有边界；只排布本次新增节点，不移动用户已有节点或相机。

用真实返回的 version 衔接下一批。不要填构造的 jobId、手写 succeeded、伪造 mediaUrl；生成状态由 generation_get/sync 回填。当前 MCP 不支持删除连线或节点；发现需要拆除错误引用时不要宣称已删，可以在授权范围创建新的正确生成节点并注明旧节点待用户清理。
