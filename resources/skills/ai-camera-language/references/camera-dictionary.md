# 32 项镜头词典

按原片顺序排列，与 [视频总结中的时间索引](video-summary.md#32-项完整目录) 一一对应。

「原片要点」为重述，不是逐字转录；「理解与用途」「模板」「检查」为实用化补充。英文是可用于提示词的对应表达，不表示所有名称都有唯一行业译名，也不表示模型支持专门的同名控制参数。

模板中的花括号是待填槽位。使用时替换为用户场景中的具体对象、位置、方向、速度和构图；中英文保持一致。只增加当前镜头确实需要的约束，不要求把模板里的所有技术细节都塞进每条提示词。

## 01 推镜 — Dolly in / Push-in

- **时间**：约 00:14–00:19。
- **原片要点**：摄影机逐渐靠近角色面部，取景由宽变紧。
- **理解与用途**：机位真实前移；用于收拢注意力、观察表情或突出细节。与变焦不同，前后景的相对关系会随观察位置改变。
- **中文模板**：从{主体}的{起始景别}开始，摄影机以{速度}向主体直线推进，焦距保持不变，最终停在{结束景别}，焦点保持在{对象}。
- **English**: Start on a {starting framing} of {subject}. Dolly toward the subject at {speed}, keeping the focal length unchanged. End on {ending framing}, with focus on {target}.
- **检查**：不要把「摄影机向前」写成「人物走向摄影机」；若主体也在走，说明双方相对距离的变化。

## 02 拉镜 — Dolly out / Pull-back

- **时间**：约 00:19–00:23。
- **原片要点**：镜头逐渐拉远，让更多环境进入画面。
- **理解与用途**：机位后退，主体通常变小；用于揭示处境、扩大空间或形成疏离感。
- **中文模板**：从{主体}的{近景}起始，摄影机以{速度}直线后退，焦距保持不变，逐渐显露{环境信息}，停在{远景构图}。
- **English**: Begin with {close framing} of {subject}. Dolly backward at {speed} without changing focal length, revealing {environmental information}. End on {wide composition}.
- **检查**：不要只写 zoom out；不要同时要求主体画面尺寸完全不变，除非确实要变焦推拉。

## 03 摇镜 — Pan

- **时间**：约 00:23–00:27。
- **原片要点**：视线向右扫动。
- **理解与用途**：摄影机位置不变，原地水平改变朝向；用于扫视空间、从 A 看向 B 或追随横向动作。原片简短描述没有严格区分机位移动与转向，实际提示词应补清。
- **中文模板**：摄影机固定在{位置}，由{A}以{速度}向右水平摇摄至{B}，机位不平移，高度和焦距保持不变。
- **English**: From a fixed position at {location}, pan right from {A} to {B} at {speed}. Keep the camera position, height and focal length unchanged.
- **检查**：左右方向以摄影机视角为准；横向搬动摄影机是横移，不是 pan。

## 04 原片「移镜」— Tilt / 仰摇、俯摇

- **时间**：约 00:27–00:31。
- **原片要点**：镜头从某处向上或向下倾斜，屏幕名称却写作「移镜」。
- **理解与用途**：依据动作而不是误导性标签，将其理解为固定机位的上下俯仰；可从脚部仰摇到面部，或从建筑顶部俯摇至入口。原片名称保留作核对，不沿用其歧义。
- **中文模板**：摄影机固定在{位置}，从{下方对象}以{速度}向上仰摇至{上方对象}，机位高度不变，不做整机升降。
- **English**: Keep the camera at {location}. Tilt upward from {lower target} to {upper target} at {speed}, without raising or translating the camera.
- **检查**：需要向下时同步改为俯摇 / tilt down；不得把这一条输出成横向 dolly，也不要与第 06 项升降混淆。

## 05 横移 — Truck / Lateral dolly

- **时间**：约 00:31–00:35。
- **原片要点**：镜头从位置 A 横向移动到 B。
- **理解与用途**：摄影机沿横向轨道或路径平移，用前后景视差表现空间；若主体也移动且镜头与其并行，则接近侧跟镜。
- **中文模板**：摄影机在{高度}从{A}平稳向右横移到{B}，焦距不变，镜头朝向保持{朝向}，让{前景}与{背景}呈现不同的位移。
- **English**: Truck right smoothly from {A} to {B} at {height}. Keep the focal length and {viewing direction} unchanged, showing parallax between {foreground} and {background}.
- **检查**：横移与原地摇摄不同；如需移动时持续瞄准主体，应明确追加缓慢转向，而不是暗示朝向同时固定和追踪。

## 06 升降镜 — Pedestal up / down

- **时间**：约 00:35–00:39。
- **原片要点**：摄影机从 A 升起或下降到 B。
- **理解与用途**：改变整台摄影机的高度，而不仅是镜头抬头或低头；用于跨越遮挡、呈现人物或环境的垂直关系。较大幅度、带弧线的设备运动可另称 crane，但不需为 AI 画面虚构设备。
- **中文模板**：摄影机在{水平位置}从{起始高度}以{速度}垂直上升至{结束高度}，朝向保持{朝向}，最终呈现{结束构图}。
- **English**: Pedestal up vertically from {starting height} to {ending height} at {speed}, keeping the horizontal position and {viewing direction} unchanged. End on {composition}.
- **检查**：下降时改写方向；如同时俯仰追踪主体，明确写出复合动作，不能用单独 tilt 代替升降。

## 07 环绕镜 — Orbit / Arc shot

- **时间**：约 00:39–00:43。
- **原片要点**：摄影机围绕主体转过指定角度。
- **理解与用途**：摄影机改变自己在主体周围的位置，通常持续朝向主体；用于展示立体关系或增强人物的中心感。
- **中文模板**：摄影机从{主体}的{起始侧面}开始，以{速度}沿{方向}绕行{角度}，保持{距离和高度}并持续对准主体，结束于{终点方位}。
- **English**: Orbit {subject} from {starting side} in a {direction} arc of {angle} at {speed}. Maintain {distance and height}, keep the camera aimed at the subject, and end at {ending side}.
- **检查**：说明方向的参照，例如俯视下顺时针；不要让人物自转冒充摄影机环绕，也不要混同画面滚转。

## 08 变焦推拉 — Dolly zoom

- **时间**：约 00:43–00:47。
- **原片要点**：摄影机移动与变焦同时发生，主体尺寸近似稳定，背景产生显著空间变化；原片用希区柯克效果作提示。
- **理解与用途**：用于眩晕、震惊或空间压迫。背景变化来自观察位置与焦距联动，不能仅要求背景任意变形。
- **中文模板**：摄影机缓慢远离静止的{主体}，同时逐渐拉长焦距，使主体在画面中的大小基本不变；背景透视随退行发生变化，呈现逐渐压缩、逼近的感觉，保持主体结构稳定。
- **English**: Dolly backward from the stationary {subject} while zooming in to keep the subject approximately the same size in frame. Let the background perspective change and appear increasingly compressed, while the subject remains structurally stable.
- **检查**：反向方案是向前推进并 zoom out。后退＋zoom out 会让主体双重缩小，不能实现该模板的恒定主体尺寸。

## 09 手持抖动 — Handheld

- **时间**：约 00:47–00:51。
- **原片要点**：利用轻微或强烈的手持晃动，必要时配合运动模糊或焦点变化。
- **理解与用途**：用于临场、纪录、紧张或慌乱感；轻微呼吸式晃动和剧烈奔跑晃动是不同强度，必须作选择。
- **中文模板**：以手持摄影机观察{主体动作}，保持{景别}，带有{选定强度}的不规则微小晃动，焦点以{对象}为主，画面仍能清楚辨认关键动作。
- **English**: Film {subject action} handheld in {framing}, with {chosen intensity} irregular camera shake. Prioritize focus on {target} and keep the key action readable.
- **检查**：不要同时要求「完全锁定、绝对无抖动」；也不要因原片提到对焦变化就无条件加入失焦。

## 10 甩镜 — Whip pan

- **时间**：约 00:51–00:55。
- **原片要点**：快速转向，过程带明显运动模糊。
- **理解与用途**：快速把视线从 A 移到 B，可作为转场素材或强调突发事件；甩镜本身不自动意味着已经完成跨场景剪辑。
- **中文模板**：先清晰呈现{A}，摄影机突然向{方向}快速甩动，转向期间产生明显方向性运动模糊，随后停稳在{B}并恢复清晰。
- **English**: Establish {A}, then whip-pan toward {direction} with strong directional motion blur. Settle on {B} and return to a clear, stable image.
- **检查**：一定给出落点与停稳状态；不要让整段视频始终处于模糊中。

## 11 主观镜头 — POV

- **时间**：约 00:55–00:59。
- **原片要点**：从某个对象的第一人称角度看场景，示例采用西瓜的视角。
- **理解与用途**：观众暂时占据指定对象的观察位置；可用于人物、动物或拟人化道具，不要求画面显示完整的观察者。
- **中文模板**：从{观察者}所在的{位置和高度}采用第一人称视角，看向{目标}；{目标动作}朝这一观察位置发生，画面不切换到观察者外部的第三人称机位。
- **English**: Use the first-person point of view of {observer} at {position and height}, looking toward {target}. Show {target action} directed toward this viewpoint, without switching to an external third-person view.
- **检查**：写清是谁的 POV；不要把「主体出现在画面中心」误当成该主体的第一人称。

## 12 无人机航拍 — Drone / Aerial / FPV-style

- **时间**：约 00:59–01:03。
- **原片要点**：从空中移动或快速穿行，可按速度加入边缘模糊；不想出现无人机实体时明确无人机主观视角。
- **理解与用途**：鸟瞰建立空间、空中跟随或穿行；平稳航拍与激烈 FPV 飞行不是同一种运动，不必同时使用。
- **中文模板**：采用无人机第一人称航拍视角，从{空中起点}以{速度}沿{路径}飞向{终点}，持续朝向{目标}，画面只呈现飞行视角，不出现无人机机身。
- **English**: Use a drone POV, flying from {aerial start} along {path} toward {destination} at {speed}, while looking at {target}. Show the aerial viewpoint without the drone body in frame.
- **检查**：避免路径穿过封闭实体；若要高速 FPV，另写转弯、障碍间隙和速度感，而不是默认所有航拍都剧烈翻滚。

## 13 光学变焦 — Zoom

- **时间**：约 01:03–01:07。
- **原片要点**：摄影机位置不动，通过焦距变化改变取景；原片强调与推拉的透视差别。
- **理解与用途**：把画面从宽变紧或反向展开；变焦并不因机位移动而改变透视。所谓相对大小不变，是指不同深度物体的透视尺寸关系，不是所有物体在画面中的像素大小不变。
- **中文模板**：摄影机位置和朝向保持固定，焦距由广角平稳变为长焦，取景从{起始景别}收紧到{主体的结束景别}，不向主体移动，不产生前后移动带来的透视变化。
- **English**: Keep camera position and orientation fixed. Smoothly zoom from wide-angle to telephoto, tightening from {starting framing} to {ending framing of subject}, without dollying or introducing a perspective shift from camera movement.
- **检查**：需要 zoom out 时反向变化；不要把光学变焦称作严格意义上等同于数字裁切，视频模型生成的效果也不证明存在真实光学镜头。

## 14 前跟镜 — Front tracking

- **时间**：约 01:07–01:11。
- **原片要点**：摄影机与主体同步跟拍，可参考分镜中的跟随距离；名称为「前跟镜」。
- **理解与用途**：为避免前／后含混，执行时定义为摄影机处在主体前方，面向主体并向后退行，观察移动中人物的正面反应。
- **中文模板**：{主体}沿{路线}向前行走，摄影机位于其前方、面向主体，以相同速度向后退行，保持{相对距离}与{正面景别}。
- **English**: As {subject} walks forward along {route}, track backward in front of the subject while facing them. Match their speed and maintain {distance} and {frontal framing}.
- **检查**：主体与摄影机等速时相对距离基本不变；不要又要求迅速贴近面部而不给出速度差。

## 15 侧跟镜 — Side tracking

- **时间**：约 01:11–01:15。
- **原片要点**：摄影机在主体侧面，以相近速度并行追踪。
- **理解与用途**：持续展示行走、奔跑或载具运动；横移描述摄影机自身轨迹，侧跟还额外要求它与移动主体保持关系。
- **中文模板**：{主体}沿{路线}移动，摄影机在其{左侧或右侧的具体选择}以相同速度平行跟随，保持{侧面景别}和{相对距离}，让环境向后掠过。
- **English**: Track parallel to {subject} along {route} from the {chosen side}, matching the subject's speed. Maintain {side framing} and {distance} as the environment moves past.
- **检查**：写明侧别和路线；侧跟不需要绕到主体正面，否则已成为另一条复合轨迹。

## 16 过肩镜 — Over-the-shoulder / OTS

- **时间**：约 01:15–01:19。
- **原片要点**：A 的肩部和后脑作为前景，B 的正面位于中景。
- **理解与用途**：用于对话、观察或建立两者关系；是一种构图，不必自动加运镜。原片用同一场景中的镜面关系做视觉演示。
- **中文模板**：从{A}的{选定侧}肩后拍摄，A 的肩部和部分后脑占据画面{前景位置}，对面的{B}以{中景}呈现，焦点落在 B 的脸上，摄影机保持稳定。
- **English**: Shoot over {A}'s {chosen side} shoulder. Keep part of A's shoulder and the back of their head in the {foreground position}, with {B} opposite in {medium framing}. Focus on B's face and hold the camera steady.
- **检查**：不是纯肩部特写；说明 A、B 身份、视线和空间位置，避免生成额外的人或混淆镜像与真人。

## 17 荷兰角 — Dutch angle

- **时间**：约 01:19–01:23。
- **原片要点**：画面整体保持一定的倾斜角度。
- **理解与用途**：以倾斜地平线或建筑垂直线形成不稳定构图，可表达异常、失衡或主观感受；不是必须持续旋转的动作。
- **中文模板**：以{景别}拍摄{主体}，画面沿光轴方向保持{具体倾斜角度}的荷兰角，地平线明显倾斜，整个镜头维持这一角度。
- **English**: Frame {subject} in {framing} with a sustained Dutch angle of {tilt angle}. Keep the horizon visibly tilted and hold that roll angle throughout the shot.
- **检查**：若要从水平旋转到倾斜，需写出转动过程；单独「荷兰角」不代表不断翻转。

## 18 低角度 — Low-angle shot

- **时间**：约 01:23–01:27。
- **原片要点**：低机位向上仰拍。
- **理解与用途**：摄影机低于主体视线，可强调体量、存在感或角色优势；这些情绪是可选叙事用途，不是镜头必然含义。
- **中文模板**：摄影机位于{低于主体视线的高度}，从下方向上仰拍{主体}，以{景别}呈现，背景保留{上方环境}，机位保持稳定。
- **English**: Place the camera at {height below the subject's eyeline}, looking upward at {subject} in {framing}. Include {upper background} and keep the camera steady.
- **检查**：低角度是位置与朝向，不等于摄影机正在上升，也不必贴地。

## 19 高角度 — High-angle shot

- **时间**：约 01:27–01:31。
- **原片要点**：高机位向下俯拍。
- **理解与用途**：从高于主体视线的位置观察人物与周围环境；可交代布局或弱化主体，但不必赋予固定情绪。
- **中文模板**：摄影机位于{主体}上方偏{方位}的{高度}，向下俯拍，保持{景别}，同时呈现{周边关系}。
- **English**: Position the camera above {subject} at {height}, offset toward {side}. Look down in {framing}, showing {surrounding spatial relationship}.
- **检查**：斜向俯拍与正上方垂直顶拍不同；写明偏移方位可减少误解。

## 20 虫眼视角 — Worm's-eye view

- **时间**：约 01:31–01:37。
- **原片要点**：比普通低角度更极端，摄影机几乎贴着地面，类似小虫的观察高度。
- **理解与用途**：极低机位强化近处地面和高大主体。原片以接近地面解释，并不意味着实际提示词必须始终水平拍摄；向上看是常见表达。
- **中文模板**：采用近乎贴地的虫眼视角，前景显露{地表细节}，摄影机从极低处向上看{主体}，强调其相对于地面的高度，保持{构图}。
- **English**: Use a worm's-eye view with the camera almost at ground level. Include {ground detail} in the foreground and look upward at {subject}, emphasizing its height within {composition}.
- **检查**：不要生成为普通腰部机位；虫眼描述观察位置，不要求画面中出现虫子。

## 21 旋转镜 — Camera roll

- **时间**：约 01:37–01:41。
- **原片要点**：镜头沿自身光轴转动一定角度。
- **理解与用途**：画面绕中心转动，摄影机不必绕主体移动；可表现失衡、翻转或主观眩晕。
- **中文模板**：摄影机位置固定，镜头持续朝向{主体}，画面从{初始角度}沿光轴以{方向和速度}滚转至{终止角度}，主体保持在{画面位置}。
- **English**: Keep the camera position fixed and aimed at {subject}. Roll around the optical axis from {starting angle} to {ending angle} in {direction} at {speed}, keeping the subject at {screen position}.
- **检查**：不能把主体自转或摄影机环绕当作 roll；区分这一转动过程与第 17 项的固定倾斜状态。

## 22 鸟瞰顶拍 — Overhead / Top-down

- **时间**：约 01:41–01:45。
- **原片要点**：摄影机位于主体正上方，向下拍摄。
- **理解与用途**：突出平面布局、几何形态和动作路径；这里指垂直顶视，不把所有远距离航拍都归为同一构图。
- **中文模板**：摄影机位于{主体或场景}的正上方，镜头垂直向下，以顶视构图呈现{布局或动作}，画面上方对应{空间方向}，机位稳定。
- **English**: Place the camera directly above {subject or scene}, looking straight down. Show {layout or action} in a top-down composition, with the top of the frame oriented toward {spatial direction}. Keep the camera steady.
- **检查**：俯拍应接近垂直向下，不是高处斜拍；涉及运动轨迹时保持方向一致。

## 23 遮挡揭示 — Occlusion reveal

- **时间**：约 01:45–01:49。
- **原片要点**：前景 A 起初挡住 B，遮挡解除后显露 B。
- **理解与用途**：先隐藏后揭示，形成发现感。解除遮挡可由前景移动或摄影机移动产生，写清其中一种即可。
- **中文模板**：起始时{前景 A}遮住{主体 B}，摄影机保持不动，A 向{方向}缓慢移开，逐步揭示 B 的{状态}，最终让 B 清楚可见。
- **English**: Begin with {foreground A} obscuring {subject B}. Hold the camera still while A moves slowly toward {direction}, gradually revealing B in {state}, ending with B clearly visible.
- **检查**：若选摄影机绕出遮挡，则把前景设为静止并改写机位轨迹；不要同时无意移动两者，或只写淡入而没有遮挡关系。

## 24 穿越镜头 — Fly-through / Move-through

- **时间**：约 01:49–01:53。
- **原片要点**：摄影机穿过 A 进入 B，需描述 A 的实际内容，如门框。
- **理解与用途**：一条连续路径连接两个空间；通过开口建立身临其境的进入感，不等同于硬切换地点。
- **中文模板**：摄影机从{空间 A}出发，以{速度}沿连续路径穿过{具体开口及其外观}，进入{空间 B}，最终对准{目标}，全程不中断。
- **English**: Move continuously from {space A} through {specific opening and its appearance} into {space B} at {speed}. End facing {target} in one uninterrupted shot.
- **检查**：有门框不代表门一定打开；明确可通过的开口及终点，避免凭空穿过实体墙或瞬间传送。

## 25 拉焦切换 — Rack focus

- **时间**：约 01:53–01:57。
- **原片要点**：把焦点从 A 转移到 B。
- **理解与用途**：在同一构图内改变观众注意力；需要能够区分焦平面的前后景，不是把摄影机从 A 移到 B。
- **中文模板**：摄影机位置、朝向和焦距不变，{前景 A}起初清晰、{背景 B}模糊；随后以{速度}将焦点转移到 B，使 B 清晰而 A 变虚，构图保持不变。
- **English**: Keep camera position, orientation and focal length unchanged. Start with {foreground A} sharp and {background B} blurred, then rack focus to B at {speed}, letting A soften while preserving the composition.
- **检查**：不要写成 zoom、拉远或切镜；A、B 若在近似同一焦平面，强烈的前后虚实切换就缺少依据。

## 26 子弹时间 — Bullet time

- **时间**：约 01:57–02:01。
- **原片要点**：主体动作和空中物体仿佛冻结，摄影机仍绕主体移动。
- **理解与用途**：让观众在凝固瞬间观察多个角度；普通慢动作是物体仍缓慢运动，不等于冻结加环绕。
- **中文模板**：在{动作瞬间}冻结{主体}和空中的{物体}，保持它们的姿态与空间位置不变；摄影机以{速度}沿{方向}环绕主体{角度}，展示这个凝固瞬间。
- **English**: Freeze {subject} and the airborne {objects} at {action moment}, preserving their poses and positions. Move the camera around the subject through {angle} in {direction} at {speed}, revealing the frozen moment from changing viewpoints.
- **检查**：冻结对象与运动摄影机分别描述；不要要求「全部画面完全静止」又要求环绕。无需字面生成子弹。

## 27 贴地穿越 — Ground-skimming move-through

- **时间**：约 02:01–02:05；属于片尾 6 项组合运镜。
- **原片要点**：在接近地面的高度，从 A 掠行至 B。
- **理解与用途**：强调低空穿行与地面速度感，可从家具或障碍之间穿过；虫眼视角描述低机位，这一项还要求明确的前进路线。
- **中文模板**：摄影机保持接近{地面材质}的低高度，从{A}以{速度}沿{可通过的路径}掠行至{B}，擦过{前景物体}旁侧，终点对准{目标}。
- **English**: Skim just above {ground surface}, moving from {A} to {B} at {speed} along {clear route}. Pass close beside {foreground object} and end facing {target}.
- **检查**：不要穿过地板或封闭物体；与普通飞越镜头相比，应持续体现贴近地面的视差和机位高度。

## 28 螺旋上升 — Rising spiral / Ascending orbit

- **时间**：约 02:05–02:09。
- **原片要点**：环绕与上升同时发生，也可以逐渐向外扩展。
- **理解与用途**：把主体置于空间中心，逐步揭示更大的环境。半径变化属于可选设计，不是「螺旋上升」必须无限远离主体。
- **中文模板**：摄影机从{主体}的{起始方位与高度}开始，以{方向}绕行{角度}并平稳升至{终止高度}，保持{半径策略}，始终朝向主体，结束于{构图}。
- **English**: Start at {initial side and height} around {subject}. Orbit through {angle} in {direction} while rising smoothly to {final height}, following {radius behavior}. Keep looking at the subject and end on {composition}.
- **检查**：上升与环绕需同时发生；不能只让主体旋转或只让摄影机垂直抬升。明确恒定半径还是逐渐向外。

## 29 环绕下降 — Descending orbit

- **时间**：约 02:09–02:13。
- **原片要点**：摄影机绕主体飞行，同时逐渐降低高度。
- **理解与用途**：从较高的整体关系落到主体附近，可用于从环境交代过渡到人物观察。
- **中文模板**：摄影机从{高处方位}开始，沿{方向}环绕{主体}{角度}，同时缓慢降至{较低终点}，半径保持{设定}并持续面向主体。
- **English**: Begin at {elevated position}. Orbit {subject} through {angle} in {direction} while descending slowly to {lower endpoint}, maintaining {radius setting} and keeping the subject in view.
- **检查**：终点不能落入地面或遮挡物内部；下降只是机位变化，不是人物下沉。

## 30 低角揭示 — Low-to-high reveal

- **时间**：约 02:13–02:17。
- **原片要点**：从低处拍摄并慢慢升高，视线逐渐扫向主体，最终揭示目标画面。
- **理解与用途**：升高与构图调整共同服务于逐步显露；与普通升降镜的区别在于有明确的信息揭示顺序。
- **中文模板**：从{低处前景或局部}开始，摄影机缓慢升高，并逐渐调整朝向至{主体}，依次揭示{信息顺序}，最终停在{结束构图}。
- **English**: Start on {low foreground or detail}. Raise the camera slowly while gradually redirecting it toward {subject}, revealing {information in sequence}. End on {final composition}.
- **检查**：若只要求固定机位向上看，则应改为 tilt；这一模板确实需要机位升高。

## 31 跟随推进 — Following push-in

- **时间**：约 02:17–02:21。
- **原片要点**：从主体后方跟随，同时逐渐靠近。
- **理解与用途**：跟随运动与缩短距离同时存在，可增强进入感或关注人物的下一步行动；不同于等速恒距跟拍。
- **中文模板**：{主体}沿{路径}前进，摄影机从其后方跟随，并以略快于主体的速度向前推进，将距离从{较远位置}缩短至{较近位置}，最后形成{背面或肩后构图}。
- **English**: Follow {subject} from behind along {path}. Move forward slightly faster than the subject, closing the gap from {farther distance} to {nearer distance}, and end on {rear or over-shoulder framing}.
- **检查**：要缩短距离，就不能同时要求摄影机与主体严格等速且恒距；也不要与第 14 项从前方退行的前跟镜混用。

## 32 低弧绕行 — Low-angle arc

- **时间**：约 02:21–02:25。
- **原片要点**：在低机位沿一段弧线围绕主体，可补充背景随运动的变化。
- **理解与用途**：以低角度强化主体，同时利用弧线改变背景和轮廓；这里的背景变化优先理解为视角变化，不是背景凭空换成另一场景。
- **中文模板**：摄影机保持{低机位高度}，从{起始侧面}沿{方向}绕{主体}移动{弧线角度}，持续朝向主体，让背景从{起点可见背景}逐步变为{终点可见背景}。
- **English**: Maintain {low camera height} while arcing around {subject} from {starting side}, through {arc angle} in {direction}. Keep the subject framed as the background view shifts from {initial visible background} to {final visible background}.
- **检查**：与螺旋上升区别是高度可保持不变；选择有限弧度，不默认要求绕满 360 度。

## 易混淆检查表

| 容易混用 | 判断维度 | 写法 |
|---|---|---|
| 推拉 / 变焦 / 拉焦 | 机位、焦距还是焦点在变 | 移动摄影机 / 固定机位改焦距 / 固定构图改清晰对象 |
| 摇镜 / 横移 | 原地转向还是改变位置 | Pan / truck，写出机位是否移动 |
| 原片「移镜」 / 升降 | 上下俯仰还是整机升降 | Tilt / pedestal，不依赖原片的歧义标签 |
| 环绕 / 滚转 / 荷兰角 | 绕主体移动 / 沿光轴转动 / 固定倾斜状态 | Orbit / roll / Dutch angle |
| 前跟 / 侧跟 / 跟随推进 | 摄影机方位、相对距离变化 | 前方退行恒距 / 侧方并行恒距 / 后方跟随并缩距 |
| 低角度 / 虫眼 / 低角揭示 | 低机位 / 极低机位 / 从低处升起并揭示 | 写高度、朝向及是否移动 |
| 高角度 / 顶拍 / 航拍 | 斜俯拍 / 正上方垂直向下 / 空中路径 | 不把三者都写成笼统的俯视 |
| 遮挡揭示 / 穿越 | 解除遮挡 / 摄影机经过空间开口 | 写谁动、通过哪里、看到什么 |
| 子弹时间 / 慢动作 | 物体冻结而相机运动 / 物体仍缓慢运动 | 单独交代主体、环境物体和摄影机 |

## 组合原则（skill 补充）

先选位置或视角，再选轨迹，再按需添加焦点变化。前两者常可兼容，例如「低角度＋侧跟」；同一个自由度上的相反要求必须化解，例如「机位完全固定＋向前推进」。

复合运动使用明确的同时或先后关系。示例：「先固定机位完成拉焦，随后保持焦点缓慢推进」与「一边推进一边拉焦」是不同设计。模型生成失败时优先保留叙事目标，删去非关键运动，而不是自动加入更多术语。
