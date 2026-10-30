import { PERSONA_TEMPLATES } from '../character/persona-templates.js'
export function PersonaTemplate({ section }: { section: keyof typeof PERSONA_TEMPLATES }): JSX.Element {
  const template = PERSONA_TEMPLATES[section]
  return <details className="dsh-partner-settings-advanced dsh-partner-persona-template"><summary>{template.title}参考模板</summary><p>{template.purpose}</p><pre>{template.text}</pre><small>首次创建或明确要求参考时使用；日常修改、自主优化无需套用。页面与 AI 共用这份参考。</small></details>
}
