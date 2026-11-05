import type {ApiSchema} from '../qq/action-catalog.js'
export interface BiliAction {id:string;title:string;category:string;login:boolean;write:boolean;schema:ApiSchema}
const str=(maxLength=200):ApiSchema=>({type:'string',minLength:1,maxLength})
const integer=(minimum=1,maximum=50):ApiSchema=>({type:'integer',minimum,maximum})
const bvid=str(20),id=str(30),text=str(2000),page=integer(1,100)
const action=(id:string,title:string,category:string,login:boolean,write:boolean,properties:Record<string,ApiSchema>={},required:string[]=[]):BiliAction=>({id,title,category,login,write,schema:{type:'object',properties,required,additionalProperties:false}})
export const BILI_CATEGORIES=[{id:'browse',title:'浏览与发现'},{id:'interact',title:'互动与收藏'},{id:'publish',title:'动态与分享'},{id:'notifications',title:'交流通知'},{id:'upload',title:'视频投稿'}]
export const BILI_ACTIONS:BiliAction[]=[
 action('search','搜索视频','browse',false,false,{keyword:str(100),page},['keyword']),
 action('hot','热门视频','browse',false,false,{page}),
 action('video','视频详情','browse',false,false,{bvid},['bvid']),
 action('video_stream','获取视频播放链接','browse',false,false,{bvid,page},['bvid']),
 action('comments','查看视频评论','browse',false,false,{bvid,page},['bvid']),
 action('subtitle','读取可用字幕','browse',false,false,{bvid},['bvid']),
 action('user_videos','UP 主投稿','browse',false,false,{uid:id,page},['uid']),
 action('user_dynamics','UP 主动态','browse',false,false,{uid:id,offset:str(100)},['uid']),
 action('share_link','生成视频分享链接','publish',false,false,{bvid},['bvid']),
 action('like','点赞或取消点赞','interact',true,true,{bvid,status:{type:'boolean'}},['bvid','status']),
 action('favorite_lists','查看我的收藏夹','interact',true,false),
 action('favorite_content','查看收藏夹视频','interact',true,false,{media_id:id,page},['media_id']),
 action('favorite','收藏或移出收藏夹','interact',true,true,{bvid,media_id:id,add:{type:'boolean'}},['bvid','media_id','add']),
 action('follow','关注或取消关注','interact',true,true,{uid:id,follow:{type:'boolean'}},['uid','follow']),
 action('comment','发表评论或回复','interact',true,true,{bvid,text,root:id,parent:id},['bvid','text']),
 action('image_dynamic','发布漫画／图片动态（1–9张）','publish',true,true,{text,image_paths:{type:'array',maxItems:9,items:str(1000)}},['image_paths']),
 action('dynamic','发布文字动态','publish',true,true,{text},['text']),
 action('share_dynamic','把视频分享到动态','publish',true,true,{bvid,text},['bvid','text']),
 action('repost','转发 B 站动态','publish',true,true,{dynamic_id:id,text},['dynamic_id','text']),
 action('replies','收到的评论回复','notifications',true,false),
 action('mentions','收到的 @','notifications',true,false),
 action('unread','未读通知数','notifications',true,false),
 action('upload_health','查询视频上传冷却状态','upload',true,false),
 action('upload_categories','查询投稿分区','upload',true,false),
 action('upload_draft','上传素材并保存待投稿草稿','upload',true,true,{video_path:str(1000),cover_path:str(1000),title:str(80),description:str(2000),tid:integer(1,10000),tags:{type:'array',maxItems:10,items:str(20)},copyright:{type:'integer',enum:[1,2]},source:str(200)},['video_path','cover_path','title','tid','tags']),
 action('upload_status','查询上传与投稿结果','upload',true,false,{job_id:str(32)},['job_id']),
 action('publish_video','正式提交视频投稿','upload',true,true,{draft_id:str(32)},['draft_id']),
]
export const BILI_ACTION_MAP=new Map(BILI_ACTIONS.map(a=>[a.id,a]))
export interface BiliSettings {autonomousActions:boolean;privateActions?:boolean;enabledActions:string[]}
export function biliSettings(value?:Partial<BiliSettings>):BiliSettings{return {autonomousActions:value?.autonomousActions??false,privateActions:value?.privateActions??value?.autonomousActions??false,enabledActions:[...(value?.enabledActions??BILI_ACTIONS.filter(a=>!a.login).map(a=>a.id))]}}
export function parseBiliSettings(value:unknown):BiliSettings {
 const v=value as BiliSettings
 if(v?.privateActions!==undefined&&typeof v.privateActions!=='boolean')throw Error('私有能力开关无效')
 if(!v||typeof v.autonomousActions!=='boolean'||!Array.isArray(v.enabledActions)||v.enabledActions.length>64||v.enabledActions.some(a=>typeof a!=='string'||!BILI_ACTION_MAP.has(a)))throw Error('B 站能力设置无效')
 return {autonomousActions:v.autonomousActions,privateActions:v.privateActions??v.autonomousActions,enabledActions:[...new Set(v.enabledActions)]}
}
