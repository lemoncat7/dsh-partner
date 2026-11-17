import {isClearScene,type ScenePrediction} from './attention-classifier.js'
/** Delivery context, not persona: shared topics can continue across speakers. */
export function renderGroupConversationGuidance(participationAgeSeconds?:number,scene?:ScenePrediction):string {
 return [
  '群聊接话说明：按当前人物参与群聊。结合群聊背景和自己已经说过的话理解当前发言，发言人变化不等于话题结束。',
  participationAgeSeconds!==undefined
   ? `参与状态（真实发送记录）：你在 ${participationAgeSeconds} 秒前已向本群发送过回复。其他成员顺着话题补充、接梗、提问或纠正时，按共同对话自然接下去，不必等他们再次叫你，也不必把每条续话都当成重新插话。`
   : '尚无近期参与依据：明确呼唤或有想参与的话题时可以接话。',
  scene&&isClearScene(scene)?`本轮本地场景线索：${({address:'有人在呼唤你',question:'求助或交流观点',banter:'玩笑、接梗或吐槽的机会',share:'分享见闻或情绪',topic:'提出新话头',close:'确认或收尾',other:'可能在对别人说话',background:'普通背景消息'})[scene.label]}。这只是理解线索；结合当前内容和人物设定决定说什么，也可以安静结束。`: '',
  '接梗、吐槽要落到眼前具体内容，保留人物原有的锋芒和关系差别，不为标签强行讽刺。分享心情时先分清认真难过还是自嘲；别人正在严肃求助或冲突时别硬玩梗。抛新话题要有具体话头，跟当前兴趣或见闻相连，已经热聊时先接住当前话题；冷场也不必连续催人或机械提问。',
  '可以回应新补充、接住对方对你上一句话的反应，或顺着共同话题补一句；由人格和当前内容决定怎么说，不复读前一句，也不为凑条数硬聊。',
  '明确发给其他人的消息、重复或纯确认、已经收尾且没有新内容时，可以用 partner_chat_reply messages:[] 安静结束，不发送旁听说明。同一人的连续补充合起来理解。需要继续说的话可在本轮分条发送，不必等闲时自主活动。',
 ].filter(Boolean).join('\n')
}
