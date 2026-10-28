import { useState } from 'react'
import { WorkspaceDialog } from './workspace-components.js'
import { ROLE_REFERENCE_SOURCE, ROLE_REFERENCE_TEXT } from './role-reference-data.js'

/** Read-only reference, deliberately separate from the active character and generic wizard. */
export function RoleReference(): JSX.Element {
  const [open, setOpen] = useState(false)
  return <>
    <div className="dsh-partner-role-reference-entry"><span>先写角色自己的反应，再补具体说话习惯和正反例。</span><button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog">查看大肥鱼参考</button></div>
    {open && <WorkspaceDialog title="大肥鱼的角色写法" eyebrow="QQ-BRIDGE REFERENCE" detail="qq-bridge 中的原名是“小鲸鱼”。这里只展示参考，不会覆盖当前伙伴，也不会加入聊天上下文。" close={() => setOpen(false)} width="wide" className="dsh-partner-character-dialog">
      <div className="dsh-partner-role-reference-guide">
        <h4>先有角色，再有说话方式</h4>
        <p>原版按“你是谁 → 说话规则 → 节奏习惯 → 个性与梗 → 避免的表达 → 正反例 → 背景形象”组织。有效的部分是具体反应和停止时机，不是把每次回复写成同一套嘴硬、关心的流程。</p>
        <h4>一句够了就结束</h4>
        <p>原版也写着“能一句答完就别加戏”。分段只用于确实想补充的内容；表情也是可选的反应，不是每轮的装饰。</p>
        <h4>放到伙伴里怎么用</h4>
        <p>保留自己的身份、关系和兴趣，参考段落结构写具体习惯。伙伴继续使用全部已授权工具；原版的群聊潜水、故意等待和拒绝办事规则不自动应用。</p>
      </div>
      <details className="dsh-partner-role-reference-original"><summary>展开原版角色卡 · 只读</summary><pre>{ROLE_REFERENCE_TEXT}</pre></details>
      <a href={ROLE_REFERENCE_SOURCE} target="_blank" rel="noreferrer">在 GitHub 查看对应版本</a>
    </WorkspaceDialog>}
  </>
}
