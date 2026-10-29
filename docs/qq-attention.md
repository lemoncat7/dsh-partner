# QQ 群聊接话：会话归属与本地语义（2.21.3）

2.21.2 的逐条加权抽签会误拦截呼唤、赞叹和追问。2.21.3 改为会话归属优先，不再对正在进行的聊天逐条抽签。

## 路由顺序

1. 真实 @ 伙伴、引用伙伴已确认发送的消息、直接叫角色名或归属账号使用关系称呼：进入回复流程。
2. 真实 @ 他人、引用已确认属于其他成员的消息：旁听。引用对象仅来自实际收发记录，不能通过文本 CQ 码或伪造引用字段指定。
3. 同一群内按发言人保留最近成功发送的对话，持续五分钟；其他人插话不会清除它，也不能继承它。明确转向他人或要求停止会结束此人的接话状态。仅入队、发送失败或选择旁听不会延长窗口。
4. 没有明确归属的新消息由本地分类器辅助识别呼唤、交流、对别人说、结束、背景消息。正在聊天时不把“好的”“哇太棒了”等逐条重新分类。
5. 只有置信分值至少 0.72 且第一、第二类别差值至少 0.35 的否定分类可以拦截新话题。其他不确定结果、超时、服务不可用均交给正常回复模型结合上下文判断。这些分值不是经过概率校准的准确率。

进入回复流程不保证每条必回。角色聊天启用时，自主群聊的 `partner_chat_reply` 可以使用 `messages: []` 安静结束；只有当前可信来源路由属于自主白名单群时允许，私聊和浏览器消息不允许借此空回复。不会向 QQ 发送“决定旁听”等技术提示，不增加常驻工具。

## 模型与验证范围

采用冻结的 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` INT8 ONNX 编码器，加本地训练的 L2 正则化 softmax 分类头。不是完整 SetFit 微调，也没有直接套用论文训练模型。分类头用仓库中 197 条通用中英文及少量日文样本训练，不将用户私有聊天上传或写入训练集。

独立编写的 40 条测试样例包含最近漏回的短句，分类准确率 90%；23 条呼唤/交流样例在这一小样本内全部归入正向类别。不能据此承诺真实群聊零漏判。完整结果（包括错误）见 `ops/attention/evaluation-report.json`；测试集不参与训练。另有路由测试验证换人、过期、不同群、发送失败、引用真实性、故障放行与权限边界。

本机离线单条平均约 6.4 ms、P95 约 8.8 ms，进程峰值 RSS 约 541 MiB；容器实测可能不同。模型 118,308,126 字节、分词器 17,082,913 字节。服务只处理短文本，不生成回复、不执行 QQ 操作、不保存聊天；运行中无需联网下载。正式回复仍使用原模型，不能据此保证总回复时间低于 5 秒。

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

重新加载伙伴插件后读取配置。未配置则仅使用会话路由并对不确定消息放行。客户端总超时 1.2 秒；失败后 30 秒内降级，不反复等待。单进程最多一个分类请求在途，繁忙时也降级放行。通过 `/health` 检查就绪。停用时先移除配置并重载插件，再停止分类服务。

源码与样本修改后，可安装 requirements.txt，运行 train.py、evaluate.py 重新生成分类头和报告。不得把测试样例添加进训练集后继续宣称原测试集准确率。

## 参考与许可

- [Addressee and Response Selection for Multi-Party Conversation](https://aclanthology.org/D16-1231/)
- [A Large-Scale Corpus for Conversation Disentanglement](https://aclanthology.org/P19-1374/)
- [SetFit](https://huggingface.co/docs/setfit/en/index)：少样本分类思路参考，本实现没有微调编码器。
- [句向量模型及 Apache-2.0 许可](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2)
- [ONNX 转换权重](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)，固定修订 `2c4055b12046f11709e9df2c122e59ffbdc2f900`。

本实现借鉴对话分流与对象识别的设计原则；它不是上述论文算法的完整复现。归属账号只影响关系设定与已有授权，接话判断不会授予工具权限。
