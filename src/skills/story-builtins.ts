import type { BuiltinSkill } from './director-builtins.js'

const integration = `
## 伙伴内置版适配（先于上游平台操作说明）

本包是离线创作技能和资源，不提供 Oh Story 创作台、HTTP 接口、自动 hooks 或专用工具。卸载 @oh-story/dsh 不影响本包。
以下路径相对于本技能工具返回的 rootPath；读取某份上游文件后，它的相对引用以该文件所在目录为准。只读取当前阶段所需资料，不把全套模块一次塞入上下文。
上游的 /skill、$skill 和“调用某模块”表示读取 upstream/skills/<模块>/SKILL.md 并应用，不意味着同名命令或工具已安装。
角色名称表示分工方法，不是已注册的子 Agent。使用当前已授权伙伴；没有对应伙伴时由当前会话分阶段完成并如实说明，不自动创建伙伴或修改 Agent 预设。
原文涉及 oh_story_role、oh_story_reference、oh_story_production 等插件工具时，不尝试调用它们。改用当前可用的文件、检索和媒体工具；没有可替代能力时说明缺项，只完成能验证的部分。
不运行平台安装、代理注册、插件更新、自更新、自动 hooks 部署或 Dashboard 启动步骤；不写 .claude、.codex、.agents 等运行时配置来模拟原插件。普通小说项目的目录和内容文件仍可按任务创建。
资源目录只读，创作产物写到用户选择的项目目录；不要为执行脚本把工作目录切到技能资源目录后向其中写产物。脚本仅按已阅读的用法运行，先确认输入输出路径、依赖和副作用。
生成图片、视频、语音等需真实已授权工具或配置；现有“画布创作与分镜生产”技能被启用时按它的真实工具映射操作，不声称上游脚本已经对接画布。不得读取或输出密钥，不把凭据写进项目。
付费或对外操作遵守当前授权，制作计划不是投产确认；失败后先查询已提交任务，不重复付费提交。文件存在、附件发送成功、媒体生成成功和质量验收分别提供证据。
原始许可与固定提交记录保留在 upstream/ 和 manifest.json 中；原文中的平台专属说明仅作参考，以本节适配边界为准。
`

function builtin(id: string, name: string, description: string, tags: string[], body: string, version = '1.0.0'): BuiltinSkill {
  return {
    entry: { id, name, description, version, tags, skillUrl: `builtin:${id}`, sourceId: 'builtin' },
    resourceBundle: id,
    document: `---\nname: ${id}\ndisplay-name: ${name}\ndescription: ${description}\nversion: ${version}\ncontext: inline\n---\n# ${name}\n${integration}\n${body}`,
  }
}

export const STORY_BUILTINS = new Map<string, BuiltinSkill>([
  ['story-creation', builtin('story-creation', '小说创作（Oh Story 内置版）',
    '长短篇小说规划、续写、拆文、导入旧稿、设定追踪、审稿和去 AI 味；按需使用 Oh Story 的离线资料与脚本，不依赖原插件创作台。', ['小说', '写作', '审稿'], `
## 选择当前任务

不要先执行上游 story-setup 的运行时部署流程；已有稿件先定位书目录、章节和当前任务，无项目时只建立用户需要的小说文件结构。

| 任务 | 读取模块 |
| --- | --- |
| 长篇规划、分卷、细纲、续写 | upstream/skills/story-long-write/SKILL.md |
| 短篇创作 | upstream/skills/story-short-write/SKILL.md |
| 导入旧稿 | upstream/skills/story-import/SKILL.md |
| 长篇 / 短篇拆文 | upstream/skills/story-long-analyze/SKILL.md / upstream/skills/story-short-analyze/SKILL.md |
| 一致性审查 | upstream/skills/story-review/SKILL.md |
| 去 AI 味 | upstream/skills/story-deslop/SKILL.md |
| 选题与榜单调研 | upstream/skills/story-long-scan/SKILL.md / upstream/skills/story-short-scan/SKILL.md |
| 封面 | upstream/skills/story-cover/SKILL.md |

原文依据来自用户稿件或实际检索，不把灵感写成原作事实；没有联网或浏览器工具时不编造榜单结果，也不启动 CDP 或接管登录态。
upstream/roles/ 保存专业角色资料，可以按当前分工读取，而不依赖同名 Agent。导入或续写时先检查已有设定与追踪记录，不覆盖用户的最新稿件。
作者明确要求记住习惯时，读取 upstream/skills/story/references/author-memory.md；只有实际成功写入并返回有效回执才能说已记住。不要从单次写作要求推断长期偏好。
上游自动 hook 在此版本不运行，章节交付前依所选模块手动检查设定一致性、追踪更新和实际产物；检查没运行就明确说明。
许可：upstream/LICENSE.upstream。上游 https://github.com/zenstory-ai/oh-story-claudecode，版本 0.8.4。

## 交给漫剧与画布

只有用户要求改编或画布生产时才进入交接，不把小说完成当作生成授权。提供实际章节路径和版本、原文定位、人物/造型/场景状态、事件顺序、不可改事实和获准改编范围。
已有剧本/分镜时沿用其来源与编号；没有时由已启用的“漫剧制作”按需要产出分集、SHOT/IMG/MOTION 及 REF/PLAN 清单，不直接把整章发去生视频。
已有真实参考图保留路径、顺序和用途；文字设定和拟生成图片标为待制作。“画布创作与分镜生产”负责来源到节点/任务/结果的台账，具体按它的 references/story-handoff.md 执行；其他技能未启用就交付文档与缺项，不自动安装或授权。
后续正文变化只标记受影响镜头供复核，不能据此自动重生成、改写冻结分镜或覆盖认可结果。
`, '1.1.0')],
  ['novel-game-creation', builtin('novel-game-creation', '小说改编互动游戏',
    '把小说或故事改编为互动叙事和可玩游戏，覆盖原作拆解、玩法概念、世界与视觉设计、构建和基于证据的验收。', ['小说', '游戏', '互动叙事'], `
## 按阶段读取

先读取 upstream/skills/novel-to-game/SKILL.md 及其 references/pipeline-contract.md，再根据当前交接阶段读取同级模块：novel-game-analyze、game-concept、game-world-design、game-art-direction、game-build、game-qa。
明确目标平台、可交付程度和原作使用范围。保留 PRODUCT_BRIEF.md 与 SOURCE_BIBLE.md 的依据，玩法和状态变化必须可验证，不把普通聊天套壳称为可玩游戏。
沿用 quick / director / resume 模式；用户只要求分析或某个阶段时不自动跑全流程。构建与测试用实际运行环境；无法运行时交付源文件并标注未验证，不宣称通过试玩。
本包不提供原插件的游戏预览 iframe。若需要预览，使用用户批准的本地运行方式，不自动开放公网端口。
内置包保留全部七个技能模块及其参考资料，不分发上游 examples/ 示例游戏成品和素材。上游 README 中的示例链接仅作来源索引，不代表本地文件存在；需要样例时再按用户需要从下方固定版本来源查看，不自动下载，不照搬其中素材作为用户获准使用的资产。
许可：upstream/LICENSE。上游 https://github.com/zenstory-ai/novel-to-game，版本 0.4.0。
`, '1.0.1')],
  ['video-recap-production', builtin('video-recap-production', '视频解说与剪辑',
    '基于已有视频进行内容理解、解说稿、剪辑计划、配音和合成，保留原声策略与断点续跑证据；不把脚本可用等同于已配置生成服务。', ['视频', '解说', '剪辑'], `
## 按需编排

先读取 upstream/skills/video-recap/SKILL.md。按任务读取 upstream/skills/ 下的 video-understanding、video-script、video-cut、video-voiceover、video-assemble 的 SKILL.md；不要把这些名称当作已注册工具。
先确认实际源视频、授权用途、时长和声音策略；只有稿件需求时止于稿件。保留 work_dir 中的来源记录、时间轴、采用文件与任务清单，来源或参数不匹配时不得复用旧结果。
脚本的视觉理解、TTS、语音克隆和质量检查可能依赖特定服务、Python 包、ffmpeg/ffprobe。执行前检查相应依赖；本包不自动安装或配置这些服务。无服务时可交付有依据的脚本与剪辑计划，不伪造转写、时间戳、配音或成片。
严守画面时间和解说落点，以实际媒体验证合成；克隆声音需获得适当许可。复用已有采用音轨时按原协议核对来源，不把用户确认过的声音自动替换。
许可：upstream/LICENSE。上游 https://github.com/zenstory-ai/video-recap-skills，版本 0.6.0。
`)],
])
