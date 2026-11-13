import type {Companion} from '../domain.js'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {ChannelActivitySummary} from '../channels/activity-registry.js'
import {activityJournalRecall} from './activity-journal.js'

/** Only bounded execution metadata from this session. No new memory or model call. */
export function activityChoiceContext(companion:Companion,events:readonly SessionEvent[],catalog:ChannelActivitySummary[],sessionId?:string,now=Date.now()):string {
  const rows=sessionId?activityJournalRecall(companion,sessionId,true,events,40)
    .filter(r=>Number.isFinite(r.at)&&r.at<=now&&now-r.at<=7*86400_000).slice(-12):[]
  const kinds=[
    ['创作或修改文件',/^(write|write_file|edit|edit_file|generate_image)(:|$)/],
    ['网页或视频资料',/^(web_|partner_browser:|partner_bilibili:(search|hot|video|video_stream|comments|subtitle|user_videos|user_dynamics)$)/],
    ['表情浏览或整理',/^(partner_stickers:|partner_qq:(fetch_custom_face_detail|add_custom_face|modify_custom_face|move_custom_face_to_front|delete_custom_face)$)/],
    ['空间浏览',/^partner_qq:(get_qzone_feeds|get_qzone_msg_list|get_qzone_msg_detail)$/],
    ['空间或B站互动发布',/^(partner_qq:(send_qzone_msg|like_qzone|comment_qzone)|partner_bilibili:(like|favorite|follow|comment|dynamic|image_dynamic|share_dynamic|repost))$/],
    ['聊天表达',/^partner_(chat_|voice_reply:|send_attachment$)/],
    ['休息',/^partner_sleep:sleep$/],
  ] as const
  const counts=kinds.map(([kind,re])=>({kind,rounds:rows.filter(r=>r.tools.some(t=>t.ok&&re.test(t.name))).length})).filter(x=>x.rounds)
  // Compare activity categories, not accounts. Legacy :call records remain unknown.
  const unknownRounds=rows.filter(r=>r.tools.some(t=>/^partner_(qq|bilibili):call$/.test(t.name))).length
  const candidates=catalog.flatMap(group=>group.activities.flatMap(activity=>{
    if(!activity.discoveryOperations?.length)return []
    const matching=rows.filter(r=>r.tools.some(t=>activity.operations?.some(op=>t.name===activity.tool+':'+op)))
    const failedRecently=matching.some(r=>now-r.at<6*3600_000&&r.tools.some(t=>!t.ok&&activity.operations?.some(op=>t.name===activity.tool+':'+op)))
    if(failedRecently)return [] // No automatic retry pressure after a failed external operation.
    return [{channelId:group.channelId,activity:activity.id,title:activity.title,tool:activity.tool,
      discoveryOperations:activity.discoveryOperations,observedRounds:matching.length,lastAt:matching.at(-1)?.at??0}]
  })).sort((a,b)=>a.observedRounds-b.observedRounds||a.lastAt-b.lastAt||a.channelId.localeCompare(b.channelId)||a.activity.localeCompare(b.activity))
  // First offer different channels, then fill remaining slots by recent use.
  // A provider with many categories must not crowd every other channel out.
  const shortlist:typeof candidates=[]
  const channels=new Set<string>()
  for(const candidate of candidates){
    if(channels.has(candidate.channelId))continue
    shortlist.push(candidate);channels.add(candidate.channelId)
    if(shortlist.length===3)break
  }
  for(const candidate of candidates){
    if(shortlist.length===3)break
    if(!shortlist.includes(candidate))shortlist.push(candidate)
  }
  const selected=shortlist.map(({lastAt,...entry})=>({...entry,...(lastAt?{lastAttemptMinutesAgo:Math.floor((now-lastAt)/60_000)}:{})}))
  return '活动选择参考（最近七天内本会话最多十二轮已完成活动；分类可重叠，只按工具结果统计，未观察到不等于从未做过）：'+JSON.stringify({sampleRounds:rows.length,counts,unknownOperationRounds:unknownRounds,explorationOptions:selected})+
    '\n先遵守明确的用户约定、当前状态和有时效的真实安排；自己的旧草稿、上轮活动和习惯不自动成为最高优先级。确有兴趣或进展可继续，若只是惯性重复，可从 explorationOptions 或完整目录挑一个符合人格与当前兴趣的方向，先浏览获得真实内容。选项按近期较少尝试排序，只是候选，不是轮流打卡、必做任务或发言配额；不合适可另选或休息。'+
    '\n浏览、互动、公开发布和私聊分享分别决定。看到内容后，依据真实感受决定是否点赞、收藏、评论或分享，不把每次浏览都转成创作任务，也不要求必须有作品才交流。没有值得表达的内容可以结束；操作结果未知先核验，失败不因候选排序自动重试。不要复述此参考或把私人对话、私人草稿直接公开。'
}
