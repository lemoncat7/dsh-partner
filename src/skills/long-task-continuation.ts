export const LONG_TASK_DESCRIPTION = '为已提交的长时间任务预约一次性唤醒，核验状态后延期或续接；需勾选定时任务能力，不新增权限。'
export const LONG_TASK_VERSION = '1.2.1'
export const LONG_TASK_DOCUMENT = `---
name: long-task-continuation
display-name: 长任务等待与续接
description: ${LONG_TASK_DESCRIPTION}
version: ${LONG_TASK_VERSION}
context: inline
allowed-tools: [partner_schedule]
---
# 长任务等待与续接

## 使用前提
伙伴必须已经勾选“定时任务”能力。技能不授予权限，不得自行开启能力、修改配置或使用系统 cron 绕过开关。没有本技能也可以按 partner_schedule 的参数说明调用。
只用于用户已经授权、已经真实提交并拿到外部任务 ID 的工作，例如视频生成、构建、数据处理。不是关注、周期日报、尚未提交的计划或普通待办。已有可靠回调或已知短时间内完成时不要再建重复轮询。

## 首次预约
1. 确认提交结果，保存外部任务 ID、服务商/系统身份、产出位置和只读状态查询方式。不得把密码、Token、Cookie、临时签名链接写进计划；只记录凭据引用。
2. 用稳定 taskKey（例如 video:provider:job-123）调用 partner_schedule action=defer，填写 externalTaskId、title、check、nextStep。check 写清状态接口/工具、成功/失败/仍运行的判断依据；nextStep 写明产物核验、后续授权步骤、已有完成步骤和用户取消条件。
3. delayMinutes 默认 2；deadlineMinutes 默认 1440；maxAttempts 默认 12。按任务预计耗时合理缩短预算；不要为小任务给无限等待。原会话由服务端记录，不自行填写其他人的会话。
4. 工具成功返回计划 ID 才能说已预约。同一任务重试使用相同 taskKey，返回旧计划不会刷新上限。结束本轮，让模型和工具释放，不 sleep 或循环刷状态。

## 到点续接
看板执行内预约必须填写 boardTaskId，等待期间由看板保留原任务，不重复派发，也不把等待说明提交验收。返回包含 continuation.board 的计划为看板托管：唤醒只核验外部任务并 resolve 后结束，nextStep 由看板恢复原委派执行；不要在定时唤醒中执行后续步骤。下面“之后执行 nextStep”仅适用于没有 continuation.board 的独立预约。不要使用周期 create 替代看板等待。

系统在原会话送入续接说明及本轮 runToken；正在执行时插入下一处理点，不等待整个对话或 Goal 完成。先用 list 核对计划仍启用且 token 相同，过期请求跳过。先检查用户是否取消、目标是否变更和产出是否已处理；收到取消请求立即 action=cancel，携带 scheduleId。删除计划也会停止续接，但不会自动取消外部服务正在执行的任务。
先按原方法查询已有 externalTaskId。服务重启、超时或状态不明时尤其不能重新提交任务，也不能把已有后续动作做第二遍；先读真实产出或服务端状态。

- 仍运行：action=resolve，scheduleId、runToken、outcome=pending、summary 填本次事实，可填 delayMinutes。建议 2→4→8→15→30→60 分钟，服务端有最低间隔和上限。延期成功后结束；不要通知“仍在等待”。
- 成功：核验本预约自己的 completion（省略时仅要求本外部任务成功且产出可回查）完成条件，立即 resolve outcome=completed 关闭本预约，summary 写证据与产出位置；之后才执行 nextStep。新长任务另行 defer，不延长已完成任务，不等待整个对话或 Goal 完成。用户取消或权限撤回后不得继续；需要审批照常申请。
- 失败、读取不到可信状态、需要用户选择或缺权限：resolve outcome=blocked，summary 写事实、已做部分和需要的处理。达到期限/次数会停止，不换 taskKey 或新建计划绕过限制。

唤醒中的 resolve 只能使用本轮 runToken，旧轮次不能覆盖新轮次。原会话提前核实等待中的任务已完成/失败时，可用 scheduleId、精确 externalTaskId、summary、outcome=completed/blocked 提前关闭，不传 runToken。没有 resolve 的口头承诺不算完成。每轮含自动续轮先 list，尚未到期的任务不重复轮询或 sleep，不为预约创建或修改 Goal。检查超时只暂停预约，不取消共享对话。预约完成、受阻和原始错误仅记内部状态，不单独通知渠道；完成授权的后续流程后才给用户最终结论和附件。新预约保存原始渠道，后续交付不跟随最近联系人；旧预约来源不明时不猜测发送。

## 最小示例
defer：{"action":"defer","taskKey":"video:provider:job-123","externalTaskId":"job-123","title":"视频生成后检查并下载","check":"用原视频服务查询 job-123；queued/running 等待，failed 受阻，completed 后核对产物链接。","nextStep":"先查本地是否已下载；未下载时保存到本任务工作目录并验证文件，报告路径，不重复生成。","delayMinutes":2,"deadlineMinutes":120,"maxAttempts":8}
resolve：{"action":"resolve","scheduleId":"工具返回的 ID","runToken":"本轮唤醒提供的 token","outcome":"pending","summary":"已查询，服务端仍为 running。","delayMinutes":4}

## 排查
没有工具：先检查定时任务能力，不要求必须安装本技能。已有任务停住：查看计划启用状态、伙伴能力、截止时间、检查次数、原会话是否归档和最近结果。受阻不等于外部任务失败，必须区分。
关闭能力后不执行预约；已经执行中的调用会请求中断，但已在外部提交的副作用无法回滚。中断后的续接默认暂停供核实，避免重复动作。
`
