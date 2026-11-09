# HackingBench

基于 **pi-coding-agent 1.5.0 + HNPF-MCP** 的 Windows 本地 LLM Hacknet 速通工作台。

> **v0.1 / 实验性适配器，不是已验证的完整 benchmark。**
> TUI、独立游戏副本、原版新账号启动、受限工具、计时/统计、日志与基础报告已经实现并做过 smoke test。
> **尚未用真实模型跑完原版战役；Labyrinths 文件会保留，但 DLC 全流程交互与评分尚未完成。**
> 原版结局检测也尚未用完整通关回归验证。当前报告不能作为正式排行榜。

## 快速开始（PowerShell 7 / Windows Terminal）

需要 Windows 原生 **Bun ≥1.4.4** 和合法安装的 Hacknet。推荐终端至少 100×32；Bun 不要使用 WSL 版本。依赖中已固定 **pi 1.5.0**，优先使用项目内安装，也可在配置中指定外部 pi。

```powershell
cd D:\Playground\HackingBench

# 首次从 Git 获取项目时：
git submodule update --init --recursive

# 自动安装本项目锁定依赖，然后进入 TUI：
.\start.ps1
```

如果当前 ExecutionPolicy 阻止运行脚本，可只对这个子进程绕过，不修改系统策略：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

也可以手动启动：

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run start
```

工作台运行、依赖安装和测试统一使用 **Bun**：直接执行 TS/TSX，使用 `bun.lock` 和 `bun test`，不再依赖 tsx/npm 或宿主 Node。共享桥接代码有意保留 Bun 支持的 `node:*` 兼容 API，供独立 pi 扩展复用；不改动 pi 自身的实现。

现在直接复用 **pi 原生全屏 TUI**，不再使用独立 Ink 配置页。上方状态面板显示 LLM activity、实时思维链、墙钟、工具/token 统计、最近动作和游戏观测；下方保留 pi 原生编辑器与斜杠命令。不会伪造未经验证的任务完成百分比。

正常启动后自动检测 Windows Bun、pi、Steam 游戏目录和 DLC。首次配置流程：

1. `/provider`：选择 CommandCode / OpenAI / Anthropic，或填写兼容接口的协议与 Base URL。
2. 编辑器会预填 `/login <项目 endpoint ID>`，按 Enter 进入 **pi 原生登录流程**；密钥输入遮罩并保存到项目 `auth.json`。
3. 登录后自动获取模型列表；使用原生 `/model` 搜索、选择远端返回的准确模型 ID。
4. 使用原生 `/thinking` 设置思考级别；它只提供当前模型支持的级别，非推理模型只有 `off`，超范围请求会自动收敛。用 `/config` 设置 L0/L1、text/text+image、游戏窗口、上下文/输出限制和本地路径。
5. `/test` 经确认后用无工具、隔离 pi 检查连接；`/setup` 可先准备游戏副本。
6. **只有 `/start` 才会开始尝试**：preflight → 必要的 setup → 项目游戏副本 → 新账号 → 工具集握手 → LLM 游玩。`/stop` 请求取消并等待 owned-process 清理。

**`/test` 和真实 `/start` 的 preflight 可能计费。** 启动界面、环境检测、准备游戏不发送模型推理请求；登录和模型选择会访问所选服务商的认证/模型目录。普通输入不会发送给模型，`!`/`!!` 宿主 shell 被禁用。不要把真实密钥发到聊天或写进仓库。

### 凭据与模型目录

无需设置密钥环境变量，也无需输入变量名。原生 `/login` / `/logout` 管理项目专属 **`runtime/controller/auth.json`**；不复制、读取或修改 `~/.pi/agent/auth.json` 或 `relays.json`。该文件与 `runtime/` 已被 Git 忽略。

- 使用 pi 原生凭据格式。**这是本地明文暂存，不是加密保险库**；Windows 访问权限继承项目目录，勿共享或上传整个 `runtime/`。
- endpoint ID 包含完整 Base URL 和协议的摘要。更换服务商、路径或协议后不会把旧 key 发到新地址；原凭据仍可通过 `/logout` 移除。
- pi 1.5.0 原生登录的 secret 标记未遮罩显示，本项目仅适配 secret 输入控件；认证流程与存储仍由 pi 完成。拒绝命令型/变量引用型 key。
- 登录后自动读取 `/models`，只接纳经过校验的模型元数据；不执行远端 `!command`，不导入 headers、凭据或执行配置。限制超时、响应大小，拒绝认证请求重定向。
- 获取失败时可 `/provider` → Refresh model list 重试，或选择 Manual model ID；手动条目标为未经目录验证。
- **当前 run 仅支持 `/provider` 配置的三种兼容协议与 API key。** 原生界面仍可展示其他账号/OAuth 登录，但它们尚未接入受限 runner；不会把 OAuth token 简单当成通用 API key。

CommandCode 预设为 `https://api.commandcode.ai/provider/v1` + Chat Completions。请从实际目录确认 `deepseek-v4.1-flash` 的准确 ID，再 `/thinking high`；尚未用真实 CommandCode key 验证，不会自动退回旧模型。`bun run start models` 仍可显式只读导入 pi-provider 的非敏感模型元数据；不会在玩家 agent 中加载 pi-provider。

API 支持：

| 配置值               | 接口               |
| -------------------- | ------------------ |
| `openai-responses`   | Responses          |
| `openai-completions` | Chat Completions   |
| `anthropic-messages` | Anthropic Messages |

非本机地址必须使用 HTTPS；拒绝 URL 中的用户名、密码、query 和 fragment。对本机模型服务允许 `http://127.0.0.1:…/v1`。

## 操作

| 命令                  | 行为                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `/provider`           | 配置 endpoint、刷新列表或手动模型 ID；不在此输入密钥                                    |
| `/login`、`/logout`   | **pi 原生**认证/移除项目凭据                                                            |
| `/model`、`/thinking` | **pi 原生**模型搜索选择、思考级别；thinking 按模型属性提供并收敛，选择同步到 bench 配置 |
| `/config [字段 [值]]` | 原生菜单设置知识/观测、游戏窗口、上下文/输出限制及本地路径；支持参数补全                |
| `/test`               | 确认后执行小型 API 连接测试，不启动游戏                                                 |
| `/setup`、`/doctor`   | 准备项目副本 / 重新检测环境                                                             |
| `/start`              | 后台开始一次尝试；demo 模式只播放合成轨迹                                               |
| `/retry`              | API 失败进入 PAUSED 后，继续同一个存活的游戏/玩家会话；不重新开局                       |
| `/stop`               | 取消目录获取、preflight 或 run，等待自己创建的进程清理                                  |
| `/report`             | 查看实验性汇总                                                                          |
| `/quit`               | 原生退出并清理当前操作                                                                  |

`/start` 不占住编辑器，运行期间可输入 `/stop`。请不要把原生 Esc 当成后台 run 的停止键。setup 的复制/下载/编译目前要等阶段完成，其他取消通过 AbortSignal、RPC abort 和 owned-PID 清理处理。模型/窗口/知识/观测设置修改不改变已经开始的尝试；每个 run 使用启动时的快照。**没有墙钟、工具调用数或 token 硬上限**：这些数字只用于统计和报告，尝试会持续到终局判定、模型调用 `hn_give_up`、基础设施错误或你执行 `/stop`。不要直接强杀工作台，否则可能留下项目游戏或锁文件。

### API 错误暂停与继续

游戏已开始后，模型连接错误、超时、429/5xx 或压缩请求失败，会先走 pi 的原生自动重试；自动工作彻底结束（`agent_settled`）后若仍有 provider 错误，工作台进入 **PAUSED**，不再立即清理游戏和玩家进程。

- 网络恢复后输入 **`/retry`**，在同一个 run、游戏账号和内存中的 pi 会话中继续；不调用新开局、不清空上下文、不重新执行已完成的工具。恢复提示要求模型先 `hn_screen` 再行动。
- `/resume` 是 pi 原生历史会话选择器，**不是本工作台的继续命令**；这里使用不冲突的 `/retry`。
- 再次失败可以再次 `/retry`，没有累计恢复次数上限；暂停期间不会自行发送模型请求。`/stop` 和 `/quit` 仍会终止并清理。
- **只暂停模型请求，不冻结 Hacknet。** 追踪、程序和墙钟继续，可能在断网期间发生游戏内失败；judge 也仍在运行。暂停次数与持续时间单独记为 `providerPauses` / `providerPauseMs`，墙钟不扣除它们。
- 仅保活恢复：工作台、游戏和 pi 子进程必须仍存活。已结束的 INFRA_ERROR、执行 `/stop`、退出或崩溃后，不能靠 `/retry` 从磁盘续跑；过去已经结束的尝试也不能因此恢复。
- 同一 run 继续使用开局时的 endpoint、模型和密钥。401/配置等错误即使被保留，也可能必须 `/stop` 后修正配置/凭据再新开；不热替换玩家密钥。不新增模型工具或宿主权限。
- 游戏进程退出、桥接/鉴权失效、pi 子进程退出、扩展错误或 RPC 通信超时仍是致命基础设施错误；尤其 prompt RPC 超时无法确定是否已接受，不能盲目重发。开局前 preflight 失败也不进入保活状态。
- Headless 模式可在 stdin 输入 `/retry` 或 `/stop`；无交互输入时用 SIGINT/SIGTERM 停止。

### 知识与观测设置

输入 **`/config`** 打开工作台设置菜单，↑↓ 选择、Enter 修改，每次确认立即保存到非敏感的 `runtime/bench.json`。Esc 取消当前输入；在主菜单按 Esc 返回面板，已经保存的更改不撤销。不需要手动编辑 JSON。

| 选项                               | 含义                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge: **L0**                  | 不附额外命令速查，由模型通过游戏内 help/教程学习；仍保留基本目标、工具说明与安全约束                                                   |
| Knowledge: **L1**（默认）          | 额外提供精简 Hacknet 命令速查；不增加宿主工具权限                                                                                      |
| Observation: **text**（默认）      | 文字观测，不向玩家开放截图工具                                                                                                         |
| Observation: **text+image**        | 保留文字工具并增加 `hn_screenshot`，只捕获游戏 framebuffer，不截图桌面；**必须选用支持图像输入的模型**，不因切换设置就自动获得视觉能力 |
| Game window width / height         | 项目副本的宽度/高度（默认 **1920×1080**，范围 640–4096 / 480–4096）；只写 `runtime/game/Settings.txt`，不改 Steam 原目录               |
| Game fullscreen: **false**（默认） | 以配置尺寸打开可移动窗口；`true` 使用全屏。窗口/全屏只在启动项目副本前应用                                                             |
| Skip intro: **false**（默认）      | `true` 跳过开场剧情文字、开机打字/闪屏等待，并通过正常 `kill PID` 关闭教程；从第一封任务邮件开始，不跳后续任务或加速后续重启           |

也可以直接设置，字段名和值均可用原生补全：

```text
/config knowledge L0
/config knowledge L1
/config observation text
/config observation text+image
/config gameWindowWidth 1920
/config gameWindowHeight 1080
/config gameFullscreen false
/config skipIntro true
```

菜单还包括上下文/单次输出限制、Hacknet 来源目录和 pi.exe 路径。游戏窗口设置在下一次 `/start`（或 `/setup` 修复副本）前写入项目副本；修改不会立即移动已打开的游戏窗口。上下文/输出限制须符合实际模型能力；路径输入留空恢复自动检测，更换游戏来源不会自动重建已准备的副本。API、密钥、模型和思考等级仍分别使用 `/provider`、`/login`、`/model`、`/thinking`；**原生 `/settings` 是 pi 自身设置，不替代 `/config`**。

### Thinking 与模型能力

`/thinking` 不再允许脱离模型任意设置：原生菜单只列出当前模型支持的级别。非推理模型只有 `off`；`xhigh` / `max` 只有在模型的 `thinkingLevelMap` 明确支持时才出现；切换模型或运行前，旧的超范围级别会按模型能力收敛（例如 `high` → `medium`）并写回 bench 配置。命令目录里的 `reasoning` 字段来自模型目录；手动模型 ID 会明确询问是否支持 extended thinking，不再用当前 `/thinking` 值反推模型能力。

Hacknet 自带的 SDL2 2.0.5 没有声明 DPI 感知；在 200% 缩放下，1920×1080 窗口会被 Windows 放大成 3840×2160 物理像素。项目副本的 BepInEx 桥接程序会在创建游戏窗口前声明 **per-monitor v2** DPI 感知（日志中的 `DPI awareness set to context -4`），所以 `/config` 的宽高就是实际窗口/渲染像素，且不修改 Steam 文件、注册表或 exe 清单。游戏 UI 本身不会随 DPI 变大；在 200% 屏幕上 1920×1080 会显示为清晰的 1920×1080 物理像素窗口，觉得 UI 太小可增大宽高或使用全屏。

有后台任务时先 `/stop` 再修改 `/config`；设置菜单明确显示 **next run**。游戏窗口与知识/观测一样属于下一次尝试；Steam 原始文件和个人存档不会被写入。已完成尝试的面板保留原启动配置，新设置用于下一次 `/start`，不重标旧结果，也不会自动开始游戏或 API 请求。

运行统计仍保留：面板显示墙钟、工具调用数、报告 token、LLM/工具耗时和 TPS；`result.json` / `result.jsonl` 记录同样字段。它们不再参与准入或停止判断。原 `/bench` 预算命令已删除；原生 `/report` 只汇总真实尝试，不把统计值当配额。

### Hacknet 原生控制台

保留 pi 原生登录、模型选择、命令补全和输入编辑器，恢复 v0.1 的青绿 / 橙色配色与圆角分区。主题仅在本工作台内注册，不修改全局 pi 配置。

- 宽屏：左侧 **Operator**，右侧 **Agent Activity + Live Terminal**，底部墙钟 / 工具 / token 实时统计；统计不是任务完成率，也不是停止条件。
- 主面板从终端首行开始，占用输入框之外的可用高度，不再受 36 行限高影响。登录、模型选择、多行输入和补全按实际高度分配空间，窄屏自动切换单栏；**TPS** 保留在 Activity 区。
- 环境检测成功只在 **Operator / Environment** 显示一次；删除重复的 MISSION、默认 STATUS 和待机说明。原生警告/错误保留在面板下方最多 4 行的可滚动反馈区，不会再把主面板推到屏幕下半部。
- TPS = **已成功完成且有可用 usage 的回复的输出 token 总数 ÷ 对应生成总秒数**，是加权平均，不是瞬时峰值。包含首 token 等待与思考耗时，排除游戏工具和清理耗时；reasoning tokens 是否计入输出数遵循服务商的 usage。
- 未收到有效 usage 时显示 `TPS —`，不按文本长度估算；停止后保留最终值。DEMO 的数值是合成预览，不参与评分。真实结果新增 `outputTokens` / `generationMs` / `tpsSamples` / `outputTps` 字段。
- 游戏观测优先提取玩家可见的终端行，保留有界的动作/观测记录，不把整段 JSON 当作终端内容；不增加玩家工具或宿主权限。

建议终端至少 **100 × 36** 以展示完整双栏；较小窗口可用紧凑布局。运行 `bun run smoke:tui` 后，可用浏览器打开 **`runtime/ui-preview/native-running-100x36.html`** 查看真实 pi 渲染输出的静态预览（本机假服务/假 runner，无真实 API 或游戏）。

### 无风险预览与命令行

```powershell
bun run demo                           # TUI 合成预览，无游戏/API/正式分数
bun run start --demo --headless          # 可脚本运行的合成预览
bun run doctor                         # 只读检测，不调用 API
bun run setup                          # 复制、下载、patch、编译，不启动游戏
bun run start models                   # 只输出模型元数据
bun run start run                      # 使用已保存配置 + 项目原生 /login 凭据开始真实尝试
bun run start report                   # 汇总真实结果
```

Demo 的成功只表示预览结束，`demo: true`、`score: 0`，不进入结果榜单。Demo 界面中的动作、耗时和中间指标为合成数据。

## Setup 实际做什么

1. 从 Steam registry / `libraryfolders.vdf` 自动定位 Hacknet，也支持手动路径。
2. 复制到 `runtime/game.staging/`，不修改 Steam 原件，不导入已有 Accounts、Reports、BepInEx 插件等。
3. 下载固定版本 **Pathfinder 5.3.4** 和 **Roslyn 4.8.0**，校验固定 SHA-256；构建无需安装 .NET SDK，使用 Windows 的 .NET Framework。
4. 在副本上安装 Pathfinder/BepInEx，移除 updater。
5. 对副本做离线/存档隔离 patch：禁用 Steam 初始化，把保存目录与游戏/Pathfinder/BepInEx 的 Documents 查询定向到 run 目录。保留 Pathfinder 自身依赖的 IL 结构；不兼容时拒绝继续。
6. 使用固定 HNPF-MCP 子模块源码和 `bridge/` 编译自有适配器，不使用上游的扩展菜单开局逻辑。
7. 写安装标记及游戏、两个 Documents 隔离相关程序集和 bridge 的指纹，完成后重命名为 `runtime/game/`。

至少需要 1.5 GB 可用磁盘空间。全部下载、编译器、游戏副本和存档位于项目 `runtime/` 下，不会提交到 Git。游戏由 Windows 原生 Bun 启动；开发时 Bash 是否来自 WSL 不影响应用架构。

启动时通过随机、鉴权的 NamedPipe 验证真实存档根，再调用原版菜单同一 New Game 回调。**不带 debug 参数，不调用 LoadMission。** 默认完整开场；启用 `/config skipIntro true` 后只跳过开场表现与教程。bridge 将开场 `IntroTextModule` 标为播放完成，并仅在首次初始化线程内移除表现性 Sleep；教程用正常终端 `kill PID` 关闭，由游戏原逻辑恢复 UI、发送第一封邮件。不直接写入任务 Flag、不加速后续重启、不推进后续任务。

## 给模型的工具

默认只开放以下 10 个工具；选择 `text+image` 后增加 `hn_screenshot`：

| 工具            | 范围                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hn_screen`     | 终端历史、已发现节点、RAM/进程、shell/IP、当前目标 proxy 状态、教程按钮；不返回隐藏密码、Flag 或任务目标答案                                                                 |
| `hn_cmd`        | 一条经过语法/作弊黑名单校验的游戏虚拟终端命令；所有游戏内 exe 可用；按行内容轮询到输出稳定，支持同一行追加和滚动历史；无变化时以 `output: snapshot` 标记当前终端上下文和状态 |
| `hn_shell`      | 驱动所有已打开的游戏 shell：对当前连接目标 overload，cancel 停止过载，exit 关闭全部；返回每个 shell 的状态/目标与真实 proxy overloadTicks；不是宿主 shell                    |
| `hn_wait`       | 等待 0.1–30 秒，再观察游戏                                                                                                                                                   |
| `hn_input`      | 只在程序等待输入时提交用户名/密码/答案，永不按命令 dispatch                                                                                                                  |
| `hn_tutorial`   | 只允许当前可见的教程 Continue / Hint 按钮，不能任意推进教程状态                                                                                                              |
| `hn_mail`       | 只列出/读取当前玩家的 inbox                                                                                                                                                  |
| `hn_reply`      | 通过原任务目标和 sender 验证提交邮件回复                                                                                                                                     |
| `hn_hub`        | 当前连接的任务板中可见合同的列出/接受                                                                                                                                        |
| `hn_give_up`    | 结束无法继续的尝试；不能自行宣布成功                                                                                                                                         |
| `hn_screenshot` | **可选**，只读取游戏 framebuffer，不截图桌面；需要支持图像输入的模型                                                                                                         |

命令拒绝控制字符、不可见分隔符、shell 元字符、盘符/UNC、父目录穿越，以及 `mcp`、`loadmission`、`loadactions`、`dscan`、`debug`、`sudo`、`execute`、`fastHack`、`revealAll` 等调试/作弊命令。**所有游戏内 exe 都可用**，包括 DLC、任务下载、`Sequencer`、`eOS_DeviceScanner`、`forkbomb`、`securitytracer` 等；未知名称只会由游戏返回 command not found，不会触达宿主。`cd ..` 仍因路径越界被禁用，可改用绝对虚拟路径。

模型不获得 read/bash/write、浏览器、任意 MCP 或 provider 管理命令。pi 使用独立 agent 目录、空 workspace、明确工具名单、禁用自动扩展/MCP/上下文文件，并在启动和每次 agent 开始时再次断言工具集。**原生 pi 会话仅在内存中保存**；磁盘轨迹由工作台统一脱敏后写入。

## 计时、判定和产物

- **没有默认墙钟、工具调用数或 token 上限。** 这些值只统计，不参与 admission 或停止判断。
- 墙钟从游戏接受输入、启动隔离 agent 的阶段开始；不含游戏复制/下载/初始开机，停止后不把清理时间算入。`skipIntro` 写入配置快照与结果；报告将跳过/完整开场分组，历史未标记结果视为完整开场。
- 分别记录墙钟、assistant 响应时间和工具执行耗时。**游戏实时运行，模型思考时不暂停追踪计时。**
- token 由 pi 统计轮询获取，包含 session 统计报告的 cached/summary 等用量；它只是报告值，不是计费硬上限，也可能包含进行中的请求。
- 运行停止条件仅为：judge 判定成功、模型调用 `hn_give_up`、致命基础设施错误或用户 `/stop`。模型/provider 失败在安全的 settled 边界进入可恢复 PAUSED，不算结束。没有自动 watchdog 或连续失败/重复动作强制停止。
- judge 是 runner 的特权通道，不把隐藏答案交给模型。当前仅实验性识别原版 credits mission，未完成完整通关回归。
- `infra_error` / `cancelled` 不计入通过率；demo 不写真实结果集。报告按 endpoint、协议、模型、thinking、知识/观测、goal、版本指纹与 adapter provenance 分组；耗时/tool/token 仅作结果字段保留。

```text
runtime/
  bench.json                       非敏感配置
  controller/
    auth.json                      pi 原生项目凭据；明文，禁止分享/提交
    <endpoint>.catalog.json        经校验的非敏感模型目录缓存
    workspace/                     原生控制面空 workspace；无宿主工具
  game/                            独立、离线 patch 后的游戏副本
  runs/<id>/
    accounts/                      这个账号的独立 XML 存档
    documents/                     游戏/Pathfinder 的独立 Documents 根
    pi-agent/                      只有本次 provider 定义；key 为环境变量引用
    workspace/                     空的模型工作目录
    config.json                    本次非敏感配置
    commands.jsonl                 游戏终端调用
    events.jsonl                   脱敏后的 RPC、观测、assistant 和诊断事件
    result.json                    状态、分数、耗时、工具/token 统计、版本、judge evidence
  results.jsonl                    真实尝试总表
  leaderboard.md                   实验性汇总，不是正式排行榜
```

密钥不写入配置、命令行参数或 system prompt；编排器日志和结果中的已知 key/token 会脱敏。日志仍可能包含你的 endpoint、模型名称、游戏内信息，按本地敏感资料管理，不自动上传。

## 验证

```powershell
bun run check                        # TypeScript + 140 个单元/回归测试，无真实 API/游戏
bun run smoke:tui                    # 原生 pi + ANSI 终端仿真、resize、登录/模型/TPS；生成静态预览
bun run smoke:pi                     # 真实 pi 1.5 RPC + 本机假模型/假桥接，无真实 API/游戏
bun run smoke:game                   # 显式启动项目内游戏 GUI，无 LLM/API/正式分数
```

已在本机验证：

- Windows Bun 1.4.4 下 TypeScript 和 140 个测试通过，包含原防线、原生控制面、密钥遮罩、endpoint 绑定、模型目录安全、响应式面板，以及 TPS 的加权/缺失 usage/取消/失败处理。新增 `/config` 菜单/参数/取消/校验/运行中锁定与配置快照回归，验证四种知识/观测组合确实改变隔离玩家的 prompt、图像输入声明及准确工具名单；游戏窗口宽高/全屏设置包含边界校验、保留其他 Settings.txt 行、幂等写入和禁止越界写入测试。另含预算字段/命令移除、统计只计数不停止、thinking 按 `reasoning` / `thinkingLevelMap` 收敛，以及 `hn_shell` 只驱动游戏内 shell overload、所有游戏内 exe 默认放行且只拦截调试/作弊命令、hn_cmd 自动轮询输出/状态快照的回归。终端回归覆盖超过30行、固定29行滚动窗口、同一行追加、多批/延迟输出、清屏后输出、最后一次屏幕读取竞态与取消；`scripts/check-terminal-history.ps1` 使用临时游戏程序集夹具（仅禁用副本的 BepInEx module initializer，不启动游戏）验证真实 bridge 的100行读取、尾部窗口和原地更新。真实 game smoke 也断言超过30行后连续 `ls` 的主结果包含目录输出，不只检查开局 `help`。
- 真实原生 `InteractiveMode` + 开发测试用 `@xterm/headless`：检查实际 ANSI viewport，验证面板、遮罩 `/login`、项目凭据写入/移除、原生模型选择弹窗和 high thinking、后台假 `/start` / `/stop`、55–200 列 / 最高 70 行窗口 resize 和 TPS 保留；包含 168×54、200×70 大屏首行定位、环境摘要去重、多行编辑与补全检查，以及原生 `/config` 菜单、L0/L1、text/text+image 选择与 55×20 设置菜单；生成 `runtime/ui-preview/` 下的 HTML/text 预览。不启动游戏，不调用真实 API。
- 可选原生游戏 smoke（不调用 API）：BepInEx 加载第 3 个插件声明 per-monitor-v2 DPI；1920×1080 windowed 的物理客户区和游戏截图均为 1920×1080，并验证教程、登录、隔离存档、owned-PID 清理与个人存档不变。
- 真实 pi RPC 的加载、无工具 preflight、准确工具集握手、假模型发起 `hn_screen`、假桥接响应、token 统计；从回复 usage 验证 TPS 只用输出 token。断言 `high` 实际序列化为请求中的 `reasoning_effort: high`，以及阻塞中的 preflight 可以取消并等待 owned-process 清理。另用本机假服务连续返回503，确认原生重试耗尽后暂停请求、恢复同一 sessionId、保留工具结果且没有重放旧工具；原生 TUI smoke 覆盖 PAUSED、`/retry` 与同一尝试恢复。
- 原版新账号、教程 Continue 的可见状态约束、普通 connect 命令推进教程、login 提示态的两段输入、终端观测、独立 XML 保存、游戏-only 截图、按 owned PID 清理。
- 游戏 smoke 前后检查个人 Hacknet Accounts 与 Pathfinder 目录指纹，未发生变化。

**尚未完成**：真实模型的长时间 campaign run、完整教程/邮件/任务板回归、可靠 game-over/终局验证、DLC 全流程及评分、模型矩阵/重复/退出后从磁盘断点续跑、冻结游戏时间。`PLAN.md` 保留设计与这些后续里程碑。

## 故障处理

- **提示使用旧隔离 patch**：先确保没有工作台 run，把项目 `runtime/game/` 移开，再 `bun run setup`。不要对 Steam 原件运行 patch 脚本。
- **`setup.lock` / `active-run.lock` 已存在**：先检查对应工作台是否仍活着；异常退出后确认项目游戏和 pi 子进程都已结束，再手动移除该锁。程序不会按游戏进程名清场。
- **`game.staging/` 已存在**：表示安装被中断。检查后移开这个项目临时目录，再重试；程序不会擅自覆盖未知目录。
- **游戏中 API 连接错误 / 429 / 5xx**：看到 PAUSED 后修复网络，输入 `/retry` 保持同一会话继续；不要误用 `/start`（新开局）或 pi 原生 `/resume`（历史会话选择）。暂停不冻结游戏；`/stop` 会结束尝试。
- **API 401/协议错误**：检查 `/provider` 的 Base URL/协议、原生 `/login` 的 endpoint ID、精确 model ID；先 `/test`。不要把 key 放进 URL。更换 endpoint 后必须单独登录。
- **提示需要 Bun / 意外使用 WSL Bun**：从 Windows PowerShell 启动 `bun run doctor`，确认输出 `platform: win32`、`runtime: Bun …`。不要用 `node` 或 `tsx` 启动工作台。

## 隔离边界与上游

这是 **工具笼 + 独立游戏/存档 + 进程卫生**，**不是 OS sandbox**。游戏和 pi 仍以你的 Windows 用户权限执行；无法保证第三方原生插件漏洞、恶意 endpoint 或本地同用户攻击下的系统隔离。需要强安全边界时应放入 Windows Sandbox / VM。详见 [SECURITY.md](SECURITY.md)。项目不提权、不配置防火墙、不修改全局 pi 设置、不按进程名终止游戏。

- [pi-coding-agent](https://github.com/earendil-works/pi)：原生 TUI/登录/模型选择，以及独立 RPC 玩家 agent。
- [HNPF-MCP](https://github.com/LDTchara/HNPF-MCP)：固定 commit `46b13a132f84939ab26f2e2137001824d76e8f61` 的 bridge 源码作为 Git 子模块复用；不暴露原生 MCP server。
- [pi-provider](https://github.com/BlueOcean223/pi-provider)：模型发现体验参考及可选非敏感目录来源，不在 benchmark agent 中加载。
- [Hacknet-Pathfinder](https://github.com/Arkhist/Hacknet-Pathfinder)：只安装到项目游戏副本。

不分发 Hacknet 游戏文件。使用游戏及第三方组件时遵循各自许可。
