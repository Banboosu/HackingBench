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
- 命令前置静态白名单和元字符/路径拒绝；bridge 端第二次校验。未知 exe 默认不可执行。
- 交互提示态输入独立处理：只记录等待中的输入，不调用 `OS.execute`，也不会因为后台线程切换状态而把输入变成命令。
- 教程按钮限制到游戏当前真实可见的 Continue/Hint 条件，不提供任意 advanceState、LoadMission 或 Flag 写入。
- 玩家观测不投影隐藏密码、Flag、未发现节点或 mission goals。特权 judge 与玩家工具分开。
- 截图只读取游戏 framebuffer，不访问桌面捕获 API。
- 工作台由 Windows 原生 Bun 执行，`bunfig.toml` 禁用自动 .env 加载；安装使用冻结的 `bun.lock` 并跳过 lifecycle scripts，不做运行时自动装包。
- 控制面复用 pi 原生 `/login` / `/logout`，凭据只暂存到项目 `runtime/controller/auth.json`（Git 忽略）。这是明文文件；Windows 权限继承项目目录，不提供加密或强制用户专属 DACL。API key 不写入 `bench.json`、prompt、CLI 参数或普通 run 文件。
- endpoint ID 绑定完整 URL 与协议，更换 endpoint 后不会复用旧 key。玩家 RPC 子进程仍只通过内部环境变量获得本次 key，生成的 provider 文件只含变量引用；不要求用户配置变量名，不复制认证文件进 run 目录。
- pi 1.5.0 原生登录未遮罩 secret 输入，本项目只替换 secret 输入渲染：保留原生登录/存储，屏幕只显示星号。启动前和输入时拒绝命令型/变量引用型 API key；不执行凭据中的 `!command`。
- 原生 TUI 控制面没有激活工具，普通输入不触发模型；在模型传输入口再次拒绝推理请求，拦截 `!` / `!!` 宿主 shell。后台玩家仍在独立工具笼内，不因控制台的登录/provider 管理而增加权限。
- 认证目录获取限制 HTTPS（本机可 HTTP）、15 秒/2 MiB/10000 条上限，拒绝重定向，只保存白名单模型字段；HTTP 失败不输出响应 body，不导入远端 headers/凭据/命令配置。
- pi 会话只保存在内存，持久化事件由编排器统一脱敏；渲染游戏/模型文字前过滤终端控制字符。
- 下载使用固定版本 + SHA-256；不运行更新器，不请求管理员权限。

## 不保证的事

- 这不是网络访问控制。`--offline` / `PI_OFFLINE` 禁用后台自动联网，不会在 OS 层限制出站流量。原生登录和模型选择会显式访问认证/目录接口，`/test` 与玩家 agent 会访问所选模型 endpoint。
- NamedPipe token 不防御同一 Windows 用户读取配置/进程环境；这里假设宿主和当前用户可信。
- 静态工具白名单并不是对所有游戏命令/第三方插件的形式化安全证明。发现兼容问题时应收紧权限，不要临时开放 shell 或原生 MCP 工具。
- 文件链接检查不能防御恶意并发进程的 TOCTOU 竞争。
- 模型被游戏内容 prompt-inject 时仍可能浪费预算或做出错误操作；没有外部宿主工具不等于模型不会被诱导。
- 目前没有进程 Job Object 或系统崩溃自动回收保证。强杀工作台/系统崩溃可能留下项目游戏和锁文件，需确认 PID 后人工清理。
- token 预算不是服务商计费硬上限；用量可能延迟报告，也可能包含正在进行的请求。
- 完整战役、DLC、game-over 和终局判定尚未全部验证。不要把实验性结果当成已校准的 benchmark 分数。

## 诊断与恢复

不要公开 API key、OAuth token、pipe token 或未经检查的 `runtime/`，尤其是 `runtime/controller/auth.json`。原生界面可显示其他账号/OAuth 登录，但当前受限 runner 仅支持 `/provider` 配置的 API-key 兼容端点。发生安全相关失败时停止 run，保留脱敏后的 `events.jsonl`、`result.json` 和版本指纹用于分析。不要为了“让测试通过”去掉存档根检查、加载全局 provider 扩展或直接暴露 HNPF 原生工具。

删除锁之前确认没有仍在运行的工作台，且项目副本/pi 子进程已经结束。只处理明确属于本项目的 PID；不要通过进程名批量结束 Hacknet。
