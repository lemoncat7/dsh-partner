import { useEffect, useState } from 'react'
import { api, type CompanionView } from '../client-api.js'
import { affectionProgress } from '../character/affection.js'
import type { CharacterCard } from '../character/domain.js'
import { errorMessage } from './workspace-components.js'

export function AffectionPanel({companion,card,active,disabled,onChange}:{companion:CompanionView;card:CharacterCard;active:boolean;disabled:boolean;onChange(card:CharacterCard):void}):JSX.Element {
  const [progress,setProgress]=useState(()=>affectionProgress(companion.affection))
  const [error,setError]=useState<string>()
  const [revision,setRevision]=useState(0)
  const [loading,setLoading]=useState(false)
  useEffect(()=>{
    if(!active)return
    let alive=true,running=false
    const refresh=async()=>{
      if(running||document.hidden)return
      running=true;setLoading(true)
      try{const value=await api<ReturnType<typeof affectionProgress>>(`/companions/${encodeURIComponent(companion.id)}/character/affection`);if(alive){setProgress(value);setError(undefined)}}
      catch(e){if(alive)setError(errorMessage(e))}finally{running=false;if(alive)setLoading(false)}
    }
    void refresh();const timer=setInterval(()=>void refresh(),30000)
    return()=>{alive=false;clearInterval(timer)}
  },[companion.id,active,revision])
  const enabled=card.affectionEnabled!==false
  return <div className="dsh-partner-affection">
    <div className="dsh-partner-affection-heading"><div><h4>慢慢熟悉，慢慢靠近</h4><p>这是 {companion.name} 自己的好感度。其他伙伴独立累计；这个伙伴的多个归属账号共用同一份进度。</p></div><div className="dsh-partner-character-toggle"><button type="button" role="switch" className="dsh-partner-switch" aria-label="启用好感度累计与主动加成" aria-checked={enabled} data-on={enabled} disabled={disabled} onClick={()=>onChange({...card,affectionEnabled:!enabled})}><i aria-hidden="true"/></button><span>{enabled?'已开启':'已暂停'}</span></div></div>
    <div className="dsh-partner-affection-score"><div><span className="dsh-partner-affection-level">Lv.{progress.level} · {progress.name}</span><strong>{progress.score}<small> / 100</small></strong></div><span>{progress.nextName?`距离「${progress.nextName}」还差 ${progress.remaining} 点`:'已达到最高等级'}</span></div>
    <div className="dsh-partner-affection-track" role="progressbar" aria-label={`${companion.name}的好感度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.score} aria-valuetext={`${progress.score} / 100，等级 ${progress.level}，${progress.name}`}><span style={{transform:`scaleX(${progress.score/100})`}}/></div>
    <div className="dsh-partner-affection-effect"><strong>{!card.enabled?'角色聊天关闭，加成暂停':!enabled?'累计与加成已暂停':`自主活动触发概率 ×${progress.multiplier.toFixed(2)}`}</strong><p>{progress.behavior}是否实际行动由角色判断，不会强制发送。</p></div>
    <p className="dsh-partner-character-hint">默认渠道正常累计和应用。QQ 仅对归属账号生效，同一个伙伴的群聊、私聊及多个归属账号共用进度；普通成员不累计、不获得加成，面向整个群的自主活动也不借用归属账号加成。</p>
    <details className="dsh-partner-settings-advanced"><summary>如何累计与影响主动程度</summary><p>初始 20 点。适用对象的一次有效对话完成后增加 1 点，同一伙伴每 10 分钟最多累计一次，满分 100。新功能从启用后累计，不追算旧聊天；自主活动、梦境、试聊、失败或中断回合不加分，离线或未回复也不扣分。</p><p>好感度越高，闲时自主活动每分钟的触发概率越高，最高为原概率的 2 倍，上限仍为 100%。需要已开启闲时自主活动，忙碌和睡眠规则照常生效。聊天中也会更愿意分享、发表情或语音，具体方式遵循人物设定和已开启的能力。</p><p>等级不会改变已有关系、开启新权限或增加联系次数指标。关闭后保留进度；开关修改后点击“保存身份”生效。</p></details>
    {error&&<p role="alert" className="dsh-partner-inline-error">读取失败：{error}</p>}
    <div className="dsh-partner-character-row"><span className="dsh-partner-character-hint">{progress.updatedAt?`最近累计：${new Date(progress.updatedAt).toLocaleString()}`:'尚未累计，当前为初始好感度'}</span><button type="button" disabled={loading} onClick={()=>setRevision(n=>n+1)}>{loading?'读取中…':'刷新进度'}</button></div>
  </div>
}
