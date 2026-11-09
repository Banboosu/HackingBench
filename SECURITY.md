# 安全边界

## 不提供 OS sandbox

HackingBench 的默认边界是**模型工具限制、项目内游戏副本、存档重定向和进程所有权**，不是 Windows 内核强制的沙箱。

游戏、BepInEx/Pathfinder、自有 bridge 和 pi 都以当前用户权限执行。若需要抵御第三方原生组件漏洞、恶意本地同用户进程或宿主文件系统攻击，请在 Windows Sandbox / VM 中运行整个工作台。不要在包含重要秘密的生产环境上把它当作强隔离方案。

## 已实现的防线

- Steam 原始安装只用于复制，patch/编译/启动针对项目 `runtime/game/`。
- 启动前校验安装标记与游戏/bridge SHA-256；不兼容的离线 patch 拒绝运行。
- `LocalDocumentsStorageMethod` 读取每次 run 的 `HACKINGBENCH_SAVE_DIR`，游戏/Pathfinder/BepInEx 的 Documents 查询重定向到独立目录。
- 禁用副本 Steam 初始化，由 Pathfinder 保持离线存储路径；菜单阶段再次检查实际存档根和存储方法。
- 随机 NamedPipe 名和随机 token，不连接默认管道或复用用户原版游戏实例。
- 只按自己创建的 ChildProcess PID 结束游戏/pi 及其子树；永不 `taskkill /IM Hacknet.exe`。
- pi 使用独立 agent 目录、空 workspace、明确玩家工具名单，禁用 MCP/自动扩展/skills/prompts/context files；不导入全局 auth/relays。
- 插件启动、每次 agent 开始及每次工具调用都校验工具权限。API 连接测试不启用任何工具。
- 命令前置语法/作弊命令黑名单和元字符/路径拒绝；bridge 端第二次校验。所有游戏内 exe 可执行，明确阻止调试/作弊命令。
- 交互提示态输入独立处理：只记录等待中的输入，不调用 `OS.execute`，也不会因为后台线程切换状态而把输入变成命令。
- 教程按钮限制到游戏当前真实可见的 Continue/Hint 条件，不提供任意 advanceState、LoadMission 或 Flag 写入。启动选项 `skipIntro`（默认 false）可跳过开场剧情表现/首次初始化的动画延时，并在教程就绪后仅发送一次正常 `kill PID`；第一封邮件和 UI 恢复由游戏原教程退出逻辑处理。此选项只由控制面开局配置，不增加模型工具或影响后续重启/程序计时；结果报告按开场模式分组。
- `hn_shell` 只调用游戏自己的 `ShellOverloaderExe.RunShellOverloaderExe` 来点击等价的 overload/cancel/exit，目标固定为当前连接节点，动作作用于全部活动 shell；使用包含命令名的原生 argv，观测真实 shell state/targetIP 和 proxyOverloadTicks；无活动 shell 时明确报错。不写 Flag、不跳过任务、不暴露隐藏节点或代理答案。
- 玩家观测不投影隐藏密码、Flag、未发现节点或 mission goals。特权 judge 与玩家工具分开。
- `listing:` 任务板适配只处理当前连接的真实板：配置文件存在、公共可读或已正常登录、条目仍存在；read 仅返回界面 posting 文本，教育/新闻文章不能 accept。接合同要求当前阵营匹配且无活动任务；镜像游戏原生 Accept 内联动作（仅从板中选任务、原生初始化/发信/移除条目），不接收任务路径、不改目标/Flag、不直接完成任务。离线 IL 核对与新游戏实际完成 Point Clicker 回归不代表其余任务板/DLC 全流程已经验证。
- 截图只读取游戏 framebuffer，不访问桌面捕获 API。DPI 感知由项目 bridge 在创建游戏窗口前于进程内声明；不写 HKCU 兼容性项、不改 Steam 原件或 exe 清单。
- 工作台由 Windows 原生 Bun 执行，`bunfig.toml` 禁用自动 .env 加载；安装使用冻结的 `bun.lock` 并跳过 lifecycle scripts，不做运行时自动装包。
- 控制面复用 pi 原生 `/login` / `/logout`，凭据只暂存到项目 `runtime/controller/auth.json`（Git 忽略）。这是明文文件；Windows 权限继承项目目录，不提供加密或强制用户专属 DACL。API key 不写入 `bench.json`、prompt、CLI 参数或普通 run 文件。
- endpoint ID 绑定完整 URL 与协议，更换 endpoint 后不会复用旧 key。玩家 RPC 子进程仍只通过内部环境变量获得本次 key，生成的 provider 文件只含变量引用；不要求用户配置变量名，不复制认证文件进 run 目录。
- pi 1.5.0 原生登录未遮罩 secret 输入，本项目只替换 secret 输入渲染：保留原生登录/存储，屏幕只显示星号。启动前和输入时拒绝命令型/变量引用型 API key；不执行凭据中的 `!command`。
- 原生 TUI 控制面没有激活工具，普通输入不触发模型；在模型传输入口再次拒绝推理请求，拦截 `!` / `!!` 宿主 shell。后台玩家仍在独立工具笼内，不因控制台的登录/provider 管理而增加权限。
- 认证目录获取限制 HTTPS（本机可 HTTP）、15 秒/2 MiB/10000 条上限，拒绝重定向，只保存白名单模型字段；HTTP 失败不输出响应 body，不导入远端 headers/凭据/命令配置。
- pi 会话只保存在内存，持久化事件由编排器统一脱敏；渲染游戏/模型文字前过滤终端控制字符。
- 游戏已开始后的 provider/模型请求失败，仅在 `agent_settled`（原生自动重试结束、工具不再执行）进入 PAUSED。保留同一游戏/pi 进程、鉴权管道、run 锁与配置快照；控制面 `/retry` 只发送一次新续接提示，不重放工具、不加载宿主会话或磁盘存档、不扩展玩家权限。恢复后要求模型先观察当前屏幕，但不能保证模型不会自行重复动作。
- PAUSED 只停模型请求，游戏与追踪计时继续，墙钟照常统计，judge 仍可判终局；不自动冻结游戏或无期限后台调用 API。用户可重复手动 `/retry`，无累计次数硬限制；`/stop`/退出仍清理 owned processes。RPC 超时/子进程退出/桥接或扩展故障仍致命，不因恢复功能盲目重发可能已接受的请求。关闭进程后的磁盘续跑尚未实现。
- 下载使用固定版本 + SHA-256；不运行更新器，不请求管理员权限。

## 不保证的事

- 这不是网络访问控制。`--offline` / `PI_OFFLINE` 禁用后台自动联网，不会在 OS 层限制出站流量。原生登录和模型选择会显式访问认证/目录接口，`/test` 与玩家 agent 会访问所选模型 endpoint。
- NamedPipe token 不防御同一 Windows 用户读取配置/进程环境；这里假设宿主和当前用户可信。
- 静态玩家工具清单并不是对所有游戏命令/第三方插件的形式化安全证明。发现兼容问题时应收紧权限，不要临时开放宿主 shell 或原生 MCP 工具。
- 文件链接检查不能防御恶意并发进程的 TOCTOU 竞争。
- 模型被游戏内容 prompt-inject 时仍可能浪费时间/token 或做出错误操作；没有外部宿主工具不等于模型不会被诱导。运行不设 wall/tool/token 硬上限，发现异常请主动 `/stop`。
- 目前没有进程 Job Object 或系统崩溃自动回收保证。强杀工作台/系统崩溃可能留下项目游戏和锁文件，需确认 PID 后人工清理。
- 墙钟、工具调用数和 token 只是统计，不是服务商计费硬上限，也不会自动停止运行；用量可能延迟报告，也可能包含正在进行的请求。
- 完整战役、DLC、game-over 和终局判定尚未全部验证。不要把实验性结果当成已校准的 benchmark 分数。

## 诊断与恢复

不要公开 API key、OAuth token、pipe token 或未经检查的 `runtime/`，尤其是 `runtime/controller/auth.json`。原生界面可显示其他账号/OAuth 登录，但当前受限 runner 仅支持 `/provider` 配置的 API-key 兼容端点。发生安全相关失败时停止 run，保留脱敏后的 `events.jsonl`、`result.json` 和版本指纹用于分析。不要为了“让测试通过”去掉存档根检查、加载全局 provider 扩展或直接暴露 HNPF 原生工具。

删除锁之前确认没有仍在运行的工作台，且项目副本/pi 子进程已经结束。只处理明确属于本项目的 PID；不要通过进程名批量结束 Hacknet。
