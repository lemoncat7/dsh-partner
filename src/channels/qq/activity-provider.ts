import type { ChannelActivity, ChannelActivityProvider } from '../activity-registry.js'
import { qqSettings } from './settings.js'
import { QQ_ACTIONS, QQ_ACTION_CATEGORIES } from './action-catalog.js'
import { QQ_PUBLIC_CHAT_ACTIONS, QQ_PUBLIC_SCOPED_ACTIONS } from './chat-actions.js'

/** QQ owns its discovery policy; actual execution remains in partner_qq's live guards. */
export const qqActivityProvider: ChannelActivityProvider = {
  id: 'qq.capabilities', platform: 'qq',
  discover({channel}) {
    const settings = qqSettings(channel.qq)
    const actions = QQ_ACTIONS.filter(a => settings.enabledActions.includes(a.id) &&
      (settings.autonomousActions || QQ_PUBLIC_CHAT_ACTIONS.has(a.id) && !QQ_PUBLIC_SCOPED_ACTIONS.has(a.id)))
    return QQ_ACTION_CATEGORIES.flatMap(category => (['public','private'] as const).flatMap(visibility => {
      const operations = actions.filter(a => a.category === category.id && (QQ_PUBLIC_CHAT_ACTIONS.has(a.id) ? 'public' : 'private') === visibility).map(a => a.id)
      if (!operations.length) return []
      const activity: ChannelActivity = {id:category.id+'.'+visibility,title:category.title,tool:'partner_qq',visibility,operations,
        ...(category.id==='space'?{discoveryOperations:operations.filter(op=>['get_qzone_feeds','get_qzone_msg_list'].includes(op))}:{}),
        description:(category.id==='space'?'可依据最近聊天、自己的经历或兴趣浏览空间、发说说、点赞或评论；有想表达的内容就可以发布，不必先做出作品，也不必另向聊天汇报。':category.id==='stickers'?'遇到喜欢的聊天图片可收藏，用 modify_custom_face 备注简短标签（空格或逗号分隔），收藏与备注变动后会刷新上下文标签；也可整理、去重或安静结束，不必整理后再发表情感慨。':'')+'通过 partner_tools describe 查询 partner_qq，再用其 list/describe/call 按 channelId 和具体操作执行。仅列出配置中的能力，执行仍核验当前授权、目标范围和审批；是否行动由当前场景与设定决定，目录本身不代表已执行。'}
      return [activity]
    }))
  },
}
