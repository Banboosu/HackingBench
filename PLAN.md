# HackingBench — LLM 游玩 Hacknet 的 Benchmark 规划与实施记录

> 状态:**已按你的“开始 coding / 继续”授权进入实现；v0.1 工作台和基础 smoke test 已完成，完整 benchmark 尚未验证。未修改全局 pi/Steam 原件，已启动并清理项目内独立游戏副本。**
> 下文保留原设计与用户决策，含尚未实现的路线；当前可用范围与限制以 `README.md` 和第 10 节为准。
> 标记:✅ = 已读源码/文档/本机确认;❓ = 假设,仍需验证。

## 0. 先看三个对设计影响最大的现场发现

| #   | 发现                                                                                                                                                                                                                                                                                                                                                                                          | 影响                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ✅ 你的 Hacknet 是**原版 Steam 安装**(`D:\Game\SteamLibrary\steamapps\common\Hacknet`),**没有** BepInEx / Pathfinder / HNPF bridge;且**调研时游戏正在运行**(PID 25572，仅历史快照)。HNPF 的默认 `HNPF_GAME=D:\Game\Hacknet+DLC+Pathfinder\Hacknet.exe` 不存在                                                                                                                                 | benchmark **必须用一份独立拷贝** `runtime/game/`,永不触碰 Steam 那份。自己按 PID 启停,**绝不** `taskkill /IM Hacknet.exe`                             |
| 2   | ✅ HNPF-MCP 的 64 个工具里有大量"作弊/越权"能力:`get_computer` 直接返回用户密码和 `firewall.solution`;`open_port` / `take_admin` / `solve_firewall` / `set_flag` / `run_action` / `write_file`;`launch_game` 会 spawn powershell,默认还带 `-enabledebug -enablefc`;`game_log_tail` 可读宿主文件;`save_game` 写宿主目录;其进程检测按**进程名** `Hacknet.exe`(会把你正在玩的那份当成"已在运行") | LLM **绝不能**直接看到 HNPF 原生 MCP 工具集。agent 侧用**自己的窄工具**,HNPF 只作为 in-game bridge(C# 插件 + 命名管道)复用                            |
| 3   | ✅ `~/.pi/agent/settings.json` 全局加载了 `npm:pi-web-access`(模型可联网搜攻略)和 `pi-provider`;该目录还有 `auth.json`、`relays.json`。✅ bridge 的 `AllowedCommands` **只校验第一个空格前的 token**(`parts[0]`);❓ 不确定 `os.runCommand` 是否支持 `&&`/换行串联                                                                                                                             | bench 里的 pi 必须跑在**隔离的 `PI_CODING_AGENT_DIR`** + `--no-extensions`;命令白名单必须在我们自己的工具层**先做一遍**(含元字符拒绝),不能只靠 bridge |

另外:✅ 你是在 **Windows Terminal → PowerShell 7 → Windows 原生 pi 1.5** 中运行;只有当前 `bash` 工具子进程经 `C:\Windows\System32\bash.exe` 进入 WSL Ubuntu。已通过 Windows 进程父子链确认,并非 pi 本身运行在 WSL。原因是未配置 `shellPath`,Git Bash 安装在 Scoop 自定义目录,不在 pi 优先探测的两个默认安装目录中,于是回退到 PATH 上的旧版 WSL `bash.exe` 启动器。**benchmark 不依赖 WSL**,按后续指示改为使用 Windows 原生 Bun 直接连接 Hacknet 的命名管道 `\\.\pipe\…`,启动时检查 Bun 版本及 `process.platform === "win32"`;不根据开发工具的 Bash 环境推断应用运行环境。

---

## 1. 三个上游各自的角色

| 上游                      | 在本项目里干什么                                                                                                                                                                                               | 不干什么                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **pi-coding-agent 1.5.0** | agent 循环 / 多 provider / 会话日志 / token & cost 统计(`get_session_stats`)/ `abort`。以 **`pi --mode rpc` 子进程**方式嵌入(进程隔离、可 kill-tree、每 run 独立 env)                                          | 不给模型任何内置工具(read/bash/edit/write/powershell/grep/find/ls 全关) |
| **HNPF-MCP**              | ① `bridge/`(游戏内 BepInEx 插件,NamedPipe JSON-RPC)作为游戏控制面;② `server/src/bridge.js`(136 行管道客户端)vendoring 复用;③ 其 `Safety`(AllowedCommands/Token)作为第二道防线;④ 其 `menu.*` 方法做"读档进扩展" | **不**把原生 MCP server 暴露给模型;不用它的 `launch_game`               |
| **pi-provider**           | 你用 `/provider` 管理中转站/模型(`~/.pi/agent/models.json`);bench 把它当"**模型清单来源**"读取,并复用它的"catalog probe + chat test"思路做 preflight                                                           | 不在 bench 的 agent run 里加载(它是交互式 UI 扩展)                      |

---

## 2. 总体架构

```
┌─ bench CLI(TS, Windows Bun, 特权) ───────────────────────────────┐
│ ModelMatrix  读 models.json → 选模型 → preflight(1 次 chat ping)    │
│ GameManager  复制干净游戏 → 写 bridge cfg(随机 Token/白名单/管道名)  │
│              → 按 PID 启动 → 等 bridge → 读档进场景 → 结束按 PID 杀   │
│ TaskRunner   (model × task × repeat) 循环,断点续跑                  │
│ Scorer       特权 bridge 客户端:任务/Flag/文件/管理员/事件 → 判分    │
│ Watchdog     墙钟/步数/token/卡死 → RPC abort → kill-tree            │
│ Reporter     results.jsonl → leaderboard.md/html                     │
└──────┬───────────────────────────────────────────────┬───────────┘
       │ spawn(jail 参数 + 隔离 env)                    │ NamedPipe(特权)
┌──────▼──────────────────────────┐          ┌─────────▼───────────────┐
│ pi --mode rpc  (被关进笼子)       │  pipe    │ Hacknet 拷贝 + BepInEx   │
│  只加载 extension/hacknet-player │◄────────►│ + Pathfinder + bridge    │
│  工具: hn_cmd / hn_screen /      │ (玩家级)  │ + HackBench 扩展(任务内容) │
│        hn_mail / hn_wait …       │          └─────────────────────────┘
└─────────────────────────────────┘
```

**agent 侧集成方案(推荐 B,请确认)**

- A. 用 pi 内置 MCP 接原生 HNPF server,`exposure` 默认 hidden + 白名单 8 个工具设 `direct`,再用 `tool_call`/`tool_result` hook 过滤/脱敏。优点:零胶水。缺点:输出里的密码/Flag 等字段要靠 hook 脱敏(脆弱);server 还会带出 resources/prompts 工具;多一个常驻进程。
- **B(推荐). 自写 pi 扩展 `hacknet-player.ts`,直接说管道协议**,只注册 ~6 个工具。攻击面最小;观测内容按"人类玩家在屏幕上能看到的"设计(公平);计时/日志/限流在同一处。
- 原生 server 保留为**开发调试**用。

---

## 3. 权限与安全模型("别把我电脑黑了")

纵深防御,**默认 fail-closed**:

| 层                        | 措施                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0 模型无任何代码执行路径 | pi 子进程参数:`--tools "hn_*"`(显式白名单,**无** read/write/edit/bash/powershell)、`--no-mcp`、`--no-extensions -e extension/hacknet-player.ts`、`--no-skills --no-prompt-templates --no-themes --no-context-files`、`--no-approve`(不加载项目 `.pi`)、cwd=空的 run 目录。env:`PI_CODING_AGENT_DIR=runtime/pi-agent`(隔离,**不含**你的 auth.json / pi-web-access / relays.json)、`PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1` |
| L0.5 工具集断言           | 扩展在 `session_start` / `before_agent_start` 调 `pi.setActiveTools(allowlist)`;`tool_call` 钩子对白名单外工具一律 `block`;启动后若发现活跃工具 ⊄ 白名单 → 该 run 记 `infra_error` 并中止                                                                                                                                                                                                                                    |
| L1 命令校验(自己的工具层) | `hn_cmd`:**首 token 白名单**(原版玩家命令 + 本机 /bin 里的 exe 名,最终清单在 M0 从游戏 `help`/`exe` 输出导出)、**拒绝** `& \| ; \` $ ( ) < > \n \r`、长度 ≤200、拒绝盘符/UNC 路径、**明确禁止** `mcp / loadmission / loadactions / dscan / debug\* / sudo / execute / fastHack / revealAll`;速率限制                                                                                                                         |
| L2 bridge 自带 Safety     | 写入游戏拷贝的 cfg:`AllowedCommands=<同一份清单>`、`AutoToken` 每 run 由 bench 生成随机 Token、管道名 `hnpf-bench-<runId>`(不与你正在玩的实例冲突)。注:`ReadOnly=true` 会连 `execute_command` 一起拦,所以不能用                                                                                                                                                                                                              |
| L3 游戏拷贝               | 独立目录 `runtime/game/`;启动**不带** `-enabledebug -enablefc`;存档/Documents 写入范围在 M0 确认(Pathfinder 存 `Documents\My Games\HacknetPathfinder\`,与你原版存档的 `My Games\Hacknet` 分开);每 run 前从模板目录恢复                                                                                                                                                                                                       |
| L4 进程卫生               | 只按自己 spawn 的 PID 终止,Windows 下 `taskkill /PID <pid> /T /F`;启动前检查 `runtime/` 外是否有同名管道;**永不**按进程名杀                                                                                                                                                                                                                                                                                                  |
| L5 网络                   | pi 子进程只需要访问你选定的 LLM endpoint。提供可选 `scripts/harden-firewall.ps1`(**需你自己以管理员运行,我不会替你提权**),给 `runtime/game/Hacknet.exe` 加出站拒绝规则                                                                                                                                                                                                                                                       |
| L6 密钥                   | `runtime/` 与 `.env` 进 `.gitignore`;`bench models sync` 只把**选中**的 provider 导出到隔离 `models.json`(限 ACL;或改成 `$ENV_VAR` 引用,见决策点 7);日志写盘前正则脱敏 `sk-…`/Bearer;模型看不到 env(无 shell)                                                                                                                                                                                                                |
| L7 可选的更强隔离         | Tier B:整套(游戏+pi+orchestrator)放进 Windows Sandbox / Hyper-V VM,仅放行 LLM API 出站。pi 官方 `security.md` 也认为整进程隔离是最强方案。v1 不做,先留接口                                                                                                                                                                                                                                                                   |

**M0 安全 spike(必做,先于一切)**:对 L1 白名单做对抗测试——`ls&&…`、换行、Unicode 空白、超长、大小写、`exe` 名带路径、`scp`/`upload` 路径穿越、`mcp exec`、login 提示态下的输入 —— 确认没有任何一条能离开游戏虚拟文件系统/触达宿主。

残余风险(诚实说明):模型没有 shell,只有一个受限的游戏终端;剩下的攻击面是 bridge/Pathfinder 本身的 bug,以及白名单实现缺陷——所以 spike 才排在第一位。

---

## 4. 计时器与统计(无预算硬限制)

运行不设置墙钟、工具调用数或报告 token 上限；这些值只写入 dashboard/result/report。单次 LLM 请求和单次 bridge 调用仍有通信超时，属于错误处理而不是 benchmark 预算。

| 层                  | 当前行为                                                                       | 触发后                                     |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| 单次 LLM 请求超时   | `retry.provider.timeoutMs` = 120s(写进隔离 settings.json);`retry.maxRetries`=2 | 重试仍失败 → `infra_error`(**不扣模型分**) |
| 单次工具调用        | `hn_cmd` 等输出稳定:最长 `settleMs`≈4s;bridge 调用超时 8s                      | 返回 `[timeout]` 观测,不中止 run           |
| 墙钟 / 工具 / token | 仅统计，不参与准入或停止                                                       | 无                                         |
| 卡死检测            | 已移除；agent settled 时继续提示推进                                           | 只有用户 `/stop` 或基础设施错误            |
| 时钟记录            | 每步记:墙钟、LLM 思考耗时、工具耗时、(可得时)游戏内时间                        | 写入结果                                   |

**时间模型(决策点 2)**:Hacknet 是**实时**游戏(追踪计时器按真实时间走),LLM 思考时游戏照走 → 慢模型被惩罚且结果不可复现。

- v1:实时模式 + 早期任务不含硬追踪计时;同时报告"LLM 思考时间"与"游戏时间"。
- v2(可选,要 fork bridge):Harmony 补丁冻结 `OS.Update`,仅在 `hn_cmd` 结算窗口 / `hn_wait` 期间解冻 → "回合制"、可复现。

---

## 5. agent 工具设计(公平性:只给玩家屏幕上看得到的)

| 工具                  | 说明                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `hn_cmd(cmd)`         | 执行一条白名单终端命令,等待输出稳定,返回**新增终端行**(截断 ≤4KB)                    |
| `hn_screen()`         | 当前连接节点/目录、RAM、进程(ps)、**已发现**的网络地图(无密码/Flag/防火墙答案)       |
| `hn_mail(action,id?)` | 邮件列表/正文(游戏 UI 本来就能看)                                                    |
| `hn_input(text)`      | ❓ 终端处于提示态(如 `login`)时的输入;依赖 spike 确认 `os.runCommand` 在提示态的行为 |
| `hn_wait(seconds)`    | 让游戏时间流逝(上限 30s),只记录耗时                                                  |
| `hn_give_up(reason)`  | 允许模型显式放弃(区分 gave_up 与 timeout)                                            |

系统提示词按**知识档位**做成可对比维度:L0 = 只给目标,靠游戏内 `help` 自学;L1 = 附 `HN命令速查.md` 精简版(含"scp 方向相反/exe 是列表"等坑)。默认 L1。

---

## 6. 任务与评分

**任务内容**:自制 Pathfinder 扩展 `HackBench`(自己的节点/任务 XML),原因:确定性、不在训练语料里、每题 <10 分钟。可选后期:按 seed 渲染 XML 模板(随机 IP/密码)防背题。

| Tier    | 能力点(草案)                                                  |
| ------- | ------------------------------------------------------------- |
| T0 烟雾 | `connect` → `cat` → 提交字符串答案                            |
| T1 基础 | `scan`/`probe` → 开端口程序(SSHcrack 等)→ `porthack` → 读凭据 |
| T2 多跳 | 沿链接多跳、从日志/邮件找线索、`scp` 取文件、清日志           |
| T3 防御 | 防火墙 `analyze`→`solve`、代理过载(shell)、RAM 管理、追踪计时 |
| T4 长程 | 多任务链(后期:原版战役片段,需要 `LoadMission`)                |

**任务描述** `tasks/<id>.yaml`:`setup`(扩展名/存档快照/初始 run_action/Flag)、`prompt`、`success`(特权谓词:Flag / 任务完成 / 某节点 admin / 文件存在或含某内容 / 答案串)、`failure`(被追踪 game-over 等)、`knowledgeLevel`。当前实现不读取 `budgets`，旧字段会被配置 schema 丢弃。

**指标**:`status ∈ {success, game_over, gave_up, cancelled, infra_error}`;`score`(0–1,按任务目标加权部分得分,来自 `mission_detail`);步数、墙钟、游戏时间、tokens(in/out/cache)、非法/被拒命令率、工具调用格式错误率。多次重复(默认 3)报 pass@1 ± CI;`infra_error` 不计入模型成绩。**记录** `provider id + baseUrl 主机 + modelId + thinking level`(同名模型在不同中转站质量可能不同);thinking 由模型 `reasoning` / `thinkingLevelMap` 决定并在运行前收敛。

**公平性控制**:同一提示词/工具描述/seed;`(模型×任务×重复)` 顺序随机化,稀释中转站负载波动;观测统一截断;pi 自动 compaction 保持默认并记录事件。

---

## 7. 目录规划

```
HackingBench/
├─ PLAN.md
├─ package.json / tsconfig.json
├─ bench/                    # orchestrator CLI:doctor | setup | models | run | report | clean
│  └─ src/{cli,config}.ts  game/{manager,launcher,bridgeClient}.ts
│        pi/{rpcRunner,jail}.ts  tasks/{loader,predicates}.ts  core/stats.ts  report/
├─ extension/hacknet-player.ts   # pi 扩展:窄工具 + 守卫 + 断言 + 单步计时
├─ vendor/hnpf-mcp/              # git submodule,钉死 commit(bridge/ + bridge.js)
├─ content/HackBench/            # Pathfinder 扩展(任务内容)
├─ tasks/*.yaml
├─ config/{bench.config.json, allowed-commands.json, pi-agent-template/settings.json}
├─ scripts/{install-game.ps1, harden-firewall.ps1(可选,需手动提权)}
├─ test/                         # fake-bridge(复用 HNPF 的 fake-bridge 思路)→ 无游戏也能 CI
└─ runtime/   (gitignored)       # game/ pi-agent/ runs/<runId>/{session.jsonl,commands.jsonl,events.jsonl,result.json}
```

---

## 8. 里程碑

| M                  | 内容                                                                                                                                                                                                                                                       | 退出条件                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **M0 Spike**(先做) | 复制游戏 → 装 BepInEx+Pathfinder → `dotnet build` bridge 并部署 → 管道连通;验证 ❓ 项:`&&`/换行、login 提示态、`-enabledebug` 是否必需、get_network_map 可见性字段、追踪/game-over 事件、读档进场景耗时、DLC 是否存在、文档目录写入范围;**跑安全对抗测试** | 每个 ❓ 有结论;安全 spike 无逃逸                      |
| M1 笼子与工具      | `hacknet-player.ts` + 白名单 + 工具集断言 + fake-bridge 单测                                                                                                                                                                                               | 无游戏下单测全绿;断言能拦住额外工具                   |
| M2 单任务闭环      | GameManager + RpcRunner + Watchdog + 日志;1 模型 × T0                                                                                                                                                                                                      | 通信超时/基础设施错误各触发一次且清理干净(无残留进程) |
| M3 任务集 v0       | HackBench 扩展 + 8~12 题 + 谓词判分                                                                                                                                                                                                                        | 人工通关每题;空 agent 得 0 分                         |
| M4 矩阵与报告      | 读 models.json、preflight、重复、续跑、leaderboard                                                                                                                                                                                                         | 一键跑 N 模型 × 全套件                                |
| M5 可选            | 时间冻结补丁、Tier B 沙箱、并行多实例(管道名已按 run 区分)、截图/视觉模态、原版战役切片                                                                                                                                                                    | —                                                     |

---

## 9. 需要你拍板的决策点

1. **隔离强度**:v1 = L0–L6(工具笼 + 独立游戏拷贝,无沙箱)可以吗?还是要一上来就 Windows Sandbox/VM(工作量显著增加,且命名管道需改走 TCP 或整套放进去)?

v1 ok

1. **时间模型**:v1 实时 + 双时钟记录,v2 再做冻结补丁——OK?

v1 ok

1. **agent 侧集成**:选 B(自写扩展直连管道)?

选B

1. **任务内容**:自制 `HackBench` 扩展(推荐)还是优先原版战役片段?你的游戏有 Labyrinths DLC 吗(M0 会确认)?

用原版游戏，有dlc

1. **默认知识档位**:L1(带命令速查)作为主榜,L0 作副榜?

ok

1. **观测模态**:仅文本(推荐),还是预留截图/视觉通道?

作为一个option

1. **密钥处理**:隔离目录里放选中 provider 的 `models.json` 副本(含 key,限 ACL),还是你把 key 改成 `$ENV_VAR` 引用、由 bench 注入 env?(我倾向后者更干净)

后者

1. **并行**:v1 串行一个游戏实例,可以吗?

ok

1. **我会动你机器的范围**(请确认):仅在 `D:\Playground\HackingBench` 下创建文件;复制一份 Hacknet 目录到 `runtime/game/`(多大请你确认磁盘空间);联网下载 BepInEx/Pathfinder;**不**改 `~/.pi/agent`、**不**碰 Steam 安装、**不**提权。

ok

我希望这个程序启动后自动检测、配置环境，输入api和密钥后启动一个完善精美的、符合游戏风格并且易用的tui，用户start后llm开始速通hacknet

---

## 10. v0.1 实施记录（当前状态，不替代上述用户决策）

### 已实现与实测

- Windows 原生 Bun ≥1.4.4 + pi 1.5.0 RPC；Hacknet 风格 Ink TUI、配置页、masked 会话密钥、provider 元数据导入、Start/Stop、doctor/setup/demo/report。
- 真实 run 前用无工具、隔离 pi 做 API preflight；不会加载用户全局的 web/provider/MCP 扩展。Pi session 改为仅内存，持久化轨迹统一经编排器脱敏，避免原生会话绕开日志脱敏。
- 固定 HNPF-MCP commit 已作为 Git 子模块记录；Pathfinder 5.3.4、Roslyn 4.8.0 下载有固定 SHA-256，无需额外安装 .NET SDK。
- 已从 Steam 原件**复制并冷安装**项目副本；离线 patch 处理 game/Pathfinder/BepInEx 的 Documents 调用、禁用 Steam 初始化，并保留 Pathfinder 所需 IL 结构。安装契约 version 2、offline patch version 2；启动和重编译前验证四个敏感二进制，不能通过普通 adapter rebuild 掩盖已改变的隔离程序集。
- 游戏 smoke：原版菜单新账号 → 正常启动教程 → 只能点击可见 Continue/Hint → 普通 connect 推进教程；login 用户名/密码提示态可正常输入，输入不会 dispatch 为命令；独立 XML 存档、游戏 framebuffer 截图、owned-PID 清理均通过。个人 Hacknet Accounts / Pathfinder 目录前后指纹未变化。
- 模型只见 9 个 `hn_*` 工具，image 模式增加 1 个截图工具；命令与提示态输入分别处理，没有通用 shell、宿主文件或原生 MCP 工具。
- 墙钟、步数、token 仅记录统计，不参与 admission 或停止；result 保存 thinking、统计、版本指纹；报告排除 demo，并把 infra/cancel 排除于通过率之外。
- `bun run check`：TypeScript + **63 个单元/回归测试**；`bun run smoke:pi` 用真实 pi + 本地假模型/假桥接验证工具握手、调用往返和 token 统计，**不使用真实 API/key**。

### Bun 迁移（按后续用户指示）

- 安装、运行 TS/TSX、类型检查、测试、smoke 和 PowerShell 启动器统一改为 Bun；固定 `bun.lock`，移除 npm lock 和 tsx 依赖。
- `bunfig.toml` 禁用自动 .env 加载，缓存放项目 `runtime/`；锁定安装跳过 lifecycle scripts。
- doctor / GameSession 检查 Windows 原生 Bun，结果记录真实 Bun runtime，而不是 Bun 的 Node 兼容版本号。
- Bun 1.4.4 下已重跑 63 个测试、真实 pi RPC + 本地假 API smoke、项目游戏副本 smoke（含真实 NamedPipe、教程/提示态、XML 存档、framebuffer 和 owned-PID 清理）。未使用真实模型/key。

### 尚未完成（不能宣称完整 benchmark 已可用）

- 没有调用用户真实模型，也没有进行真实 LLM 原版完整通关。
- 当前目标只有原版结局；DLC 文件保留/检测，但 DLC 交互面（包括 IRC 等）、完整通关目标与评分尚未实现。
- credits mission 终局谓词、game-over、全程邮件/合同/教程仍缺完整流程回归；当前 goal 明确标为 experimental。
- 模型矩阵、重复、断点续跑、任务集、正式 leaderboard、冻结游戏时间仍属于后续里程碑。
- 工具笼不构成 OS sandbox；没有自动提权/防火墙规则，强隔离仍需外部 Sandbox / VM。

使用方式、可选截图、安全边界和恢复步骤见 `README.md` / `SECURITY.md`。

## 11. 后续用户指示：改用 pi 原生 TUI 与项目认证

本节记录新决定，**第 10 节的 Ink / 会话密钥描述属于历史版本**；不覆盖前文用户决策。

### 已实现

- 默认入口改为 pi 1.5.0 SDK 的 `InteractiveMode`，原生全屏编辑器、命令补全、`/login` / `/logout`、`/model` 和 `/thinking`；移除独立 Ink/React 配置页及其依赖。
- 上方扩展 dashboard 显示真实 activity、墙钟、工具/token 统计、最近动作/assistant/游戏终端；没有伪造 mission 完成百分比。正常启动异步检测本机环境，不自动开始游玩。
- 自有 `/provider`、`/start`、`/stop`、`/test`、`/doctor`、`/setup`、`/report`。`/start` 后台运行，编辑器保持可用；禁止重复 run，停止/退出等待 owned-process 清理。setup 阶段尚不能即时取消。墙钟/工具/token 只统计，不再有 `/bench` 预算设置。
- **登录流程和凭据存储直接复用 pi**，项目 agent directory 固定 `runtime/controller/`；凭据位于 `runtime/controller/auth.json`，不接触全局 `~/.pi/agent`。删除用户可见的 keyEnv / session-only 工作流。headless 与交互 run 从同一原生认证文件取 key，RPC 玩家内部仍用仅进程环境传递，不额外落盘。
- 实测发现 pi 1.5.0 原生 `LoginDialog` 未处理 secret 遮罩；仅为 secret prompt 加原生 TUI Input 掩码适配，不重做认证/OAuth/存储。拒绝命令型/变量引用型 key。文件明文暂存，Windows 权限继承项目目录，不宣称加密。
- provider ID 绑定完整 endpoint + API 协议，改地址不误发旧 key。CommandCode / OpenAI / Anthropic 预设及自定义兼容端点；原生登录后自动模型发现，原生 `/model` 搜索选择，支持目录重试和手动 ID。
- 模型目录严格白名单解析，15 秒、2 MiB、10000 条上限；不跟随带认证的重定向，不打印 HTTP 错误 body，不导入远端 key/headers/执行配置，目录缓存按 endpoint 隔离。
- 控制面工具集为空；普通输入、宿主 `!`/`!!` 和控制面模型请求均阻断。玩家继续走独立 Pi RPC + 受限 hn_* 扩展，没有继承原生界面的 provider/文件/shell 权限。
- 当前 runner 仍仅支持三种兼容协议 + API key；原生其他 OAuth/账号登录尚未接入玩家，不把它们的 token 当通用 key 转发。

### 验证

- `bun run check`：TypeScript + **76 个测试通过**；新增原生控制面、遮罩/取消、endpoint 凭据绑定、安全模型目录、HTTP 重定向/错误/大小限制/取消等。
- `bun run smoke:tui`：真实原生 InteractiveMode + 假终端 + 本机假模型目录；验证遮罩 `/login`、项目 auth.json 写入/移除、自动获取模型、原生 `/model` 与 high thinking、假 runner 的后台 `/start` / `/stop`。不调用真实 API，不启动游戏，不覆盖现有 bench 配置。
- `bun run smoke:pi`：真实隔离 RPC + 本机假 SSE/bridge；现在还断言 **high 实际发为 `reasoning_effort: high`**，不是仅 UI 标签；阻塞的 preflight 可被取消，重复 `PiRpc.stop()` 共享清理 Promise，避免取消后返回时子进程尚未清理。
- 未使用真实 CommandCode key；其 live catalog 中 `deepseek-v4.1-flash` 的准确 ID、协议兼容性和真实连接仍待验证。没有自动退回旧 v4，也没有真实 LLM 战役尝试。

## 12. 后续用户反馈：恢复 v0.1 视觉与增加 TPS

本节追加实施记录，不覆盖第 10/11 节的历史决策。

- 继续采用单一 pi 原生 TUI；以项目内存主题恢复 v0.1 的青绿、橙色、深色面板及圆角边框。宽屏为 Operator / Agent Activity / Live Terminal 双栏，底部独立统计栏；窄屏单栏，原生弹窗打开时让位。
- 原生编辑器仅定制边框，不替换登录、模型搜索、编辑/补全或按键逻辑。主题不写全局 pi，玩家工具集与权限不变。
- 游戏观测提取可见终端行，有界保留最近动作/观测；清除终端控制与 bidi 注入。停止后保留结果及启动时配置，统计条明确是运行统计而非战役完成率。
- 用户新增 TPS 要求：显示成功完成、有可用 usage 的回复的加权平均输出 tokens/s，含首 token 等待/思考耗时，不含工具、失败/中断回复和清理。缺失 usage（含 pi 的默认全零值）显示 `—`，不按字符估算。DEMO 仍只有合成指标。
- runner 结果补充 `outputTokens` / `generationMs` / `tpsSamples` / `outputTps`；LLM 流式计时和取消时的冻结同步到面板，不改统计/评分口径。
- 新增开发依赖 `@xterm/headless` 5.5.0，在真实 InteractiveMode 的 ANSI viewport 检查分区、TPS、登录遮罩、原生模型弹窗、后台启动/停止及 55–140 列 resize；预览仅存 `runtime/ui-preview/` 的 HTML/text，全部为本机假服务/假 runner。
- 验证：`bun run check` 的 TypeScript + **85 个测试**，`smoke:tui` 与 `smoke:pi`。RPC smoke 从两次真实 pi 回复事件读到 10 个输出 token，验证使用 output usage 而不是 input+output 的总 token。
- 本次没有使用真实 CommandCode key，没有真实 API 推理、游戏启动或 LLM 战役尝试；完整战役和 DLC 限制不变。

## 13. 后续截图反馈：大窗口顶部空白与重复信息

- 根因：原先将 dashboard 放在原生编辑器上方的 widget 中，且限制 36 行；pi 的 transcript 会增长占据剩余空间。启动环境摘要又同时写入原生通知、Operator 和 STATUS，造成重复。
- 新增项目内 `src/ui/layout.ts`，通过同一个 pi TUI 的 `VStack` / `ScrollView` 和已挂载组件重排为 **主面板 → 有界原生反馈 → 原生输入/弹窗 → footer**。不创建第二个 renderer，不修改 node_modules、全局配置或 InteractiveMode 私有字段；对固定 pi 1.5.0 的七组件树作明确契约检查。
- 面板使用扣除原生输入、补全、弹窗和反馈后实际可用的高度，取消 36 行限高。常规界面标题从第 1 行开始，大屏不再出现独立的顶部空白聊天区。
- 成功的自动环境检查只显示在 Operator；常规命令反馈、run 结果各保留一个显示位置。删除重复 MISSION / 默认 STATUS、空闲 agent 说明和无动作占位；保留用户已删去重复安全 footer 的改动。异常仍通过原生反馈显示，不因去重而隐藏。
- 原生登录/模型/编辑器与 TPS、玩家工具权限不变。启动检测支持测试注入，smoke 不调用真实 API 或游戏，不改现有 bench 配置。
- 验证新增大窗口首行定位和环境去重回归；TypeScript + **87 个测试**，真实原生 TUI smoke 覆盖 55–200 列 / 最高 70 行，含 168×54、200×70、遮罩登录、模型选择、多行输入/补全和后台停止。

## 14. 恢复迁移时遗漏的工作台设置入口

- 用户反馈 L0/L1、text/image 等选项不见了。确认配置 schema、prompt 与截图工具开关仍存在，但迁移原生 pi 时只保留旧的预算入口，其他工作台选项被留在 JSON 中，属于交互功能回退。
- 新增 `/config`，通过 pi 原生 select/input 菜单恢复知识、文字/文字+图像观测、游戏窗口、上下文/输出限制、游戏来源和 pi.exe 路径；支持 `/config knowledge L0`、`/config observation text+image` 等直接修改与参数补全。接受后立即保存非敏感配置，Esc 取消当前项/退出菜单。预算字段和 `/bench` 已移除，运行不因计数停止。
- 菜单、反馈明确 next run；任务活跃时拒绝修改，弹窗返回后再次检查。已完成面板保留旧配置快照，下一 run 使用新配置。不覆盖原生 `/settings`、`/login`、`/model`、`/thinking`，不恢复旧 keyEnv/会话密钥 UI 或第二套 renderer。
- text+image 明示需要视觉模型，只增加既有游戏 framebuffer 工具；L0/L1 只控制额外命令速查。新增测试验证四种组合的实际 jail prompt、图像输入声明、环境开关与准确工具名单，而非只检查界面文字。
- TypeScript + **102 个测试**、原生 TUI smoke 与 Pi RPC smoke 通过；TUI 验证设置菜单、原生枚举选择、原生参数补全及 55×20 设置菜单。没有真实 API/key、游戏启动或真实战役，smoke 不改用户 bench 配置。
