import type { BuiltinSkill } from './director-builtins.js'

export const VIORA_CANVAS_BUILTIN: BuiltinSkill = {
  "entry": {
    "id": "viora-canvas-production",
    "name": "画布创作与分镜生产",
    "description": "通过 Viora MCP 管理人物、场景、分镜参考、生成节点、结果回填和附件交付。",
    "version": "1.0.0",
    "tags": [
      "画布",
      "分镜",
      "生图",
      "视频"
    ],
    "skillUrl": "builtin:viora-canvas-production",
    "sourceId": "builtin"
  },
  "resourceBundle": "viora-canvas-production",
  "document": "---\nname: viora-canvas-production\ndisplay-name: 画布创作与分镜生产\nversion: 1.0.0\ncontext: inline\ndescription: 在 Viora / infinite-canvas 中把创作需求落实为人物、场景、分镜参考图与视频生成节点，使用已授权 MCP 维护参考连线、生成任务和结果回填。适用于要求实际操作画布的创作与修订，不用于普通问答或仅润色提示词。\n---\n\n# 画布创作与分镜生产\n\n把“创作方案 → 可复用素材 → 分镜 → 生成节点 → 可检查的结果”连起来。优先复用项目中已认可的人物和场景，不把文字卡片或参考连线当作已经生成的素材。\n\n## 先确定本次做到哪里\n\n- 只要方案：交付方案，不创建项目或付费生成。\n- 要搭建画布：创建所需节点与关系，生成须符合用户授权。\n- 要实际生成：确认项目、交付类型、数量、画幅和预算边界；用户已经明确的事项不重复询问。模型数量、参数和点数以当前目录为准，不承诺免费或无限重试。\n- 修订已有项目：先读现状，只改涉及的镜头和素材，不重建整张画布。\n\n先检查当前工具里是否有 `viora_projects_list`、`viora_canvas_read`、`viora_canvas_apply`、`viora_models_list` 等能力。实际名称可能有 MCP 前缀，以当前 schema 为准。没有工具就说明缺项，不编造调用，不索取服务商密钥。\n\n## 按需读取\n\n路径相对于本 Skill 目录；在伙伴中安装时，以工具返回的 `rootPath` 为准。\n\n- 做人物、场景、镜头方案时读 [references/creative-production.md](references/creative-production.md)。已有导演技能可负责叙事与美术，本技能负责映射到画布，不重复输出两套方案。\n- 写节点、连线或提交生成前读 [references/canvas-contract.md](references/canvas-contract.md)。这是接口约束，不能用创作自由覆盖。\n- 有生成、等待、错误恢复或附件交付时读 [references/generation-delivery.md](references/generation-delivery.md)。\n- 多镜头、跨轮续接或多人协作时使用 [references/production-ledger.md](references/production-ledger.md) 的最小台账，避免混淆镜头号、节点 ID、任务 ID 和资产 ID。\n\n## 执行顺序\n\n1. 查项目、模型和现有画布；分别翻完节点与连线分页，确认目标及可复用素材。模型目录只代表配置能力，特殊适配器仍可能额外校验。\n2. 为本次工作保留简短 brief：交付、风格、人物身份、场景、镜头数量、预算。沿用用户指定内容，缺少影响结果的关键条件才问。\n3. 先锁定人物/场景基准图，再用这些**真实资产**生成分镜参考图；单镜头任务不强行扩成完整制作管线。基准不合格时先修基准，不铺开生成一批漂移镜头。\n4. 分配节点 ID，按人物/场景区、镜头区、视频区布置节点。写入描述、角色与镜头编号，并记录依赖。不要覆盖用户的布局、字段或已有认可结果。\n5. 仅对已满足依赖、参数合法、在授权预算内的节点提交生成。保留每次请求与返回 ID；查询实际任务到终态，并回填画布。\n6. 检查人物、空间、镜头方向和视频动作；失败局部修订，不以“重新生成全套”代替诊断。\n7. 最终汇报可用结果、未完成项和限制；需要文件时下载真实产物后交付附件。中间状态不是最终结果。\n\n## 不可混淆的边界\n\n- 画布连线只是引用关系，不会自动触发上游或下游生成；每次提交都必须显式提供完整 prompt 与实际参考 URL。\n- 人物/场景到分镜是身份、环境约束；参考图到视频是视觉条件。多张自由参考不等于按时间连续的关键帧。\n- 只使用当前已授权的伙伴、工具和 MCP。需要专业分工时遵守现有伙伴/看板规则，当前 Skill 不创建隐藏子 Agent、不扩大权限。\n- 网络重试复用原 requestId；修改模型、提示词或输入属于新的主动生成，先确认预算。画布同步失败不等于生成失败。\n- 长任务续接只核查已有 jobId；内部完成/失败回执不单独发渠道。最终文字和附件沿宿主保存的原渠道交付。\n"
}
