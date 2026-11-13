# QQ 群聊接话：会话归属、时间与本地语义（2.25.12）

本地分类用于快速分流，不生成回复，也不授予任何工具权限。单句被分为“交流”不代表它在向伙伴说话。

## 路由顺序

1. 明确停止接话先结束当前成员的接话状态。真实 @ 伙伴、引用伙伴已确认发送的消息、直接叫角色名或归属账号使用关系称呼仍优先进入回复流程。
2. 真实 @ 他人、引用其他成员的消息旁听；单独的确认收尾语和没有当前对话对象的孤立标点也可直接旁听。
3. 同一群、同一发言人刚收到伙伴回复，30 秒内没有新的其他成员插话时，连续补充直接进入原对话，不重复等待分类。其他人插话不删除此人的对话状态，但恢复语义判断。只有成功送达建立连续性；发送失败、仅入队和旁听不延长窗口。
4. 30 秒内其他成员正在交流、当前发言人没有自己的活跃对话且伙伴近一分钟未参与时，不靠单句的“交流”分类打断他们。面向全群的明确邀请仍可进入本地语义判断。明确呼唤和已核验引用始终先于此过滤。
5. 其余消息使用本地分类。正向类别需 confidence >= 0.65 且 margin >= 0.15；明确否定需 confidence >= 0.72 且 margin >= 0.35。不确定或服务不可用时，仅五分钟内伙伴确实回复过的同人对话可继续，新话题旁听。这些数值不是准确率。

进入回复流程不保证必回，自主白名单群中仍允许 `partner_chat_reply messages:[]` 安静结束。私聊与浏览器不能借此空回复。

## 连续消息与时间

同人同引用目标的消息跨 poll 合并，等待 600ms 安静窗口，最多 2400ms/16 条。已进入回复后，同人的后续补充通过原有 steer 机制接续；不同人、群与引用不合并。识别延迟、合并等待、主模型生成和发送耗时是不同环节。

临时群背景最多 16 条，含真实渠道时间、相隔秒数及已确认送达的伙伴回复；十分钟前的临时背景不再注入。会话时间提示细化到秒，区分快速补充和明显间隔。时间缺失或未来时间不伪造，不删除持久会话历史，不将群旁听写入长期记忆。

独占人物提示模式仍保留已开启的消息分段配置，允许一轮多条或中间继续说话；不规定最低消息数、不硬编码人物口吻。

## 排查数据

`/partner-local/v1/channels/status` 的 QQ 渠道带 `groupDecision` 和 `groupDecisions`。后者只保留当前进程最近 40 条时间、消息标识、路由、耗时和可用的分类分值；不含消息正文，不持久化。`qqLatency` 仍区分识别与主模型等耗时。重启后为空，不能用它推断重启前全量识别准确率。

## 模型与验证范围

采用冻结的 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` INT8 ONNX 编码器，加本地训练的 L2 正则化 softmax 分类头。不是完整 SetFit 微调，也没有直接套用论文训练模型。分类头用仓库中 197 条通用中英文及少量日文样本训练，不将用户私有聊天上传或写入训练集。

独立编写的 40 条测试样例包含最近漏回的短句，分类准确率 90%；23 条呼唤/交流样例在这一小样本内全部归入正向类别。不能据此承诺真实群聊零漏判。完整结果（包括错误）见 `ops/attention/evaluation-report.json`；测试集不参与训练。另有路由测试验证换人、过期、不同群、发送失败、引用真实性、故障放行与权限边界。

最初部署时的离线测试：单条平均约 6.4 ms、P95 约 8.8 ms，进程峰值 RSS 约 541 MiB；容器实测可能不同。模型 118,308,126 字节、分词器 17,082,913 字节。服务只处理短文本，不生成回复、不执行 QQ 操作、不保存聊天；运行中无需联网下载。正式回复仍使用原模型，不能据此保证总回复时间低于 5 秒。

## 部署

`ops/attention/` 提供 Dockerfile、compose、固定模型修订与 SHA256、训练及验证脚本。权重不塞入 npm 插件包。

```sh
cd ops/attention
python3 download-model.py
docker compose up -d --build
```

Compose 使用外部 `appnet`，不映射宿主机端口；限制 1 CPU、768 MiB 内存、禁止额外 swap，非 root、只读运行。宿主机设置 `DSH_PARTNER_ATTENTION_URL=http://partner-attention:8092`，或在 `$DSH_HOME/partner/local-attention.json` 写入：

```json
{"url":"http://partner-attention:8092"}
```

重新加载伙伴插件后读取配置。未配置时仅使用会话路由；没有明确呼唤或现存对话依据的新消息旁听。客户端总超时 450ms；失败后 30 秒内降级，不反复等待。单进程最多四个分类请求在途，繁忙时同样使用会话规则，不能无限排队。通过 `/health` 检查就绪。停用时先移除配置并重载插件，再停止分类服务。

源码与样本修改后，可安装 requirements.txt，运行 train.py、evaluate.py 重新生成分类头和报告。不得把测试样例添加进训练集后继续宣称原测试集准确率。

## 参考与许可

- [Addressee and Response Selection for Multi-Party Conversation](https://aclanthology.org/D16-1231/)
- [A Large-Scale Corpus for Conversation Disentanglement](https://aclanthology.org/P19-1374/)
- [SetFit](https://huggingface.co/docs/setfit/en/index)：少样本分类思路参考，本实现没有微调编码器。
- [句向量模型及 Apache-2.0 许可](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2)
- [ONNX 转换权重](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)，固定修订 `2c4055b12046f11709e9df2c122e59ffbdc2f900`。

本实现借鉴对话分流与对象识别的设计原则；它不是上述论文算法的完整复现。归属账号只影响关系设定与已有授权，接话判断不会授予工具权限。
