import type { BuiltinSkill } from './director-builtins.js'

export const DRAMA_BUILTIN: BuiltinSkill = {
  entry: { id: 'drama-production', name: '漫剧制作', description: '短剧与漫剧创作：原著改编、剧本、人物场景、分镜、跨镜一致性、图片与视频提示词、生产和剪辑。按阶段读取上游资料。', version: '1.0.0', tags: ['漫剧', '短剧', '分镜', '制作'], skillUrl: 'builtin:drama-production', sourceId: 'builtin' },
  resourceBundle: 'drama-production',
  document: `---
name: drama-production
display-name: 漫剧制作
description: 为短剧和漫剧进行原著改编、剧本创作、视觉设定、分镜与提示词制作，支持跨镜一致性检查及已授权的媒体生产和剪辑。普通问答不启用整套流程。
version: 1.0.0
context: inline
---
# 漫剧制作

来源：https://github.com/zenstory-ai/drama-skills
固定提交：b71cb3ca9343eaf6c0375725ccc9261a4e79021e；MIT，保留于 upstream/LICENSE。

## 入口与按需读取

资源路径相对于工具返回的本 Skill rootPath，不是当前项目目录。
先读取 upstream/skills/short-drama/SKILL.md，根据用户当前任务选择阶段；不要一次加载所有资料。
上游的 $short-drama-* 是资料模块，不是当前环境已注册的工具或伙伴。直接读取对应目录的 SKILL.md 并应用说明，不调用不存在的 skill 名称。原文相对引用以该原文所在目录为准。

- 原著分析：upstream/skills/short-drama-novel-analyze/SKILL.md
- 故事开发和分集：upstream/skills/short-drama-develop/SKILL.md
- 剧本：upstream/skills/short-drama-write/SKILL.md
- 人物、场景、道具及连续性：upstream/skills/short-drama-assets/SKILL.md
- 图片提示词：upstream/skills/short-drama-image-prompts/SKILL.md
- 分镜与关键帧：upstream/skills/short-drama-storyboard/SKILL.md
- 视频提示词：upstream/skills/short-drama-video-prompts/SKILL.md
- 确认后生产：upstream/skills/short-drama-produce/SKILL.md
- 剪辑：upstream/skills/short-drama-edit/SKILL.md
- 审查：upstream/skills/short-drama-review/SKILL.md

## 在伙伴中使用

保留上游的五文档创作流程、连续性锁、真实参考与计划参考区分，以及生产前预览和明确确认的边界。用户只要一个阶段就只完成该阶段，不强制补齐流水线。
本技能被选为漫剧主流程时，现有导演技能只在必要时辅助镜头语言或风格，不重复运行多套总流程。
专业分工使用已有授权伙伴和看板机制；模块 owner 表示内容职责，不自动创建伙伴或隐藏子 Agent。更新正式看板结果时提交实际摘要、证据与附件，不能仅写“完成”。
实际生成只使用当前授权的工具或 MCP；技能不授予新权限，也不保证上游列举的模型在当前账号可用。使用 Viora 时，若已启用“画布创作与分镜生产”，由它负责节点、任务与附件映射；未启用时按当前真实工具 schema 操作，不虚构调用。
上游生产脚本需要项目外 adapter 配置，不能假定它已对接 Viora；缺少配置时说明缺项，不索取密钥写进项目。保留生产预览与确认，不把预算说明或自动续接当成本批生产确认。
中断后先查询已保存的 jobId，取回结果，不重复投产。实际交付沿宿主附件和原渠道机制发送，文件路径不是已经发送的附件。

## 运行条件

上游脚本需要 Python 3.9+，剪辑另需 ffmpeg/ffprobe；调用前检查当前执行环境是否具备。仅有文件读取能力时仍可使用创作资料，但不得声称已运行检查或生成媒体。
脚本、模板和参考资料按原目录保留，使用绝对技能路径调用脚本，创作产物写入用户项目或会话目录，不写回内置资源目录。
不默认启动上游 Dashboard、安装依赖或调用付费服务。用户明确需要时才处理这些操作；不改变宿主权限、审批及渠道交付规则。
`,
}
