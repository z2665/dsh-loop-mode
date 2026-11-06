<div align="center">

<img src="docs/icon.png" width="160" alt="dsh-loop-mode icon"/>

# dsh-loop-mode

**DSH 的控制论回路模式插件：人设定目标，控制器推动执行者向目标逼近。**

`/loop on` 之后，会话变成一个反馈控制回路的控制器——目标（setpoint）→ 委派执行者（act）→ 独立验收（measure）→ 校准（calibrate），用户作为外环校准者。

[![tests](https://img.shields.io/badge/offline%20tests-43%2B5-brightgreen)](#离线测试) ![license](https://img.shields.io/badge/license-MIT-blue) ![platform](https://img.shields.io/badge/platform-DSH%20plugin-9b59b6)

</div>

设计理念来自 [MarchLiu/dsh-cybernetics](https://github.com/MarchLiu/dsh-cybernetics) 及其博客[《Cybernetics Agent——人工智能应用的新范式》](https://marchliu.github.io/2026/11/03/cybernetics-agent-new-paradigm)。本插件是它的极简重构，外加一条自己的铁律：

> **默认彻底惰性。** 不开模式，什么都不发生——没有引导注入、没有硬门、连本插件的工具都不可见不可调。

## 快速开始

```bash
# 在你的 DSH profile（如 ~/.dsh/profiles/<profile>）中：
# package.json 的 dependencies 添加：
#   "dsh-loop-mode": "link:/path/to/dsh-loop-mode"
pnpm install
# 重启宿主 + 强刷浏览器（Ctrl+Shift+R）
```

三种开启方式：

| 方式 | 效果 |
|---|---|
| **选 LOOP 模式 Agent 预设**（设置 → Agent 预设） | 该会话默认开模式（推荐） |
| 会话内 `/loop on` | 按会话持久开启（resume/fork 存活） |
| 插件卡片开 `defaultOn` | 全局默认开 |

关闭：`/loop off`（预设会话也能退）。状态与测量：`/loop status` / `/loop report`。

## 协议

模式开启后注入的控制回路协议（系统提示段要点）：

1. **SETPOINT** — `create_goal`：objective 携带可检验验收标准 + `maxGoalRounds` 轮预算。目标不可原地改写（`update_goal` 被结构性摘除），唯一改目标动词是 `loop_revise`（reason 必填、append-only 审计链）。
2. **ACT** — `loop_task {tier, description, brief}`：执行者分两档——**通用执行者**（general，常规/机械/有界任务）与**高级执行者**（senior，复杂/高风险/多步变更）。tier 由控制器按任务形态选择，**档内模型路由由插件钉死**，逐次不可绕过。执行者是 fresh 子代理，brief 即它的全部世界。
3. **MEASURE** — `loop_verify {criteria, deliverable, report, mode}`：验收分层——**quick**（单验收者，短期质量焦点，用于矫正迭代）与 **full**（三个独立评审者：架构与遵从度 / 安全 / 代码质量，全过才算 met）。每 goal quick 预算（默认 3，可配）用尽后工具**拒绝 quick 并强制 full**。验收者的提示词、路由与输出契约全部由插件署名，verdict 形状经平台 `outputSchema` 强制。
4. **CALIBRATE** — met → 回报并 `loop_pause` 等用户（完成是用户的行动，控制器没有任何 complete 动词）；未 met → 用 gaps 构造矫正 brief；`goalQuestionable` → 回对话；用户确认的目标变更 → `loop_revise`。

配套结构：

- **硬门**（`gate`，默认开）：装配层 allowlist 过滤 + 分发层兜底拒绝双层，模式开启的会话只剩读/对话/goal/委派动词。task/verify 子代理不受门限制；plan mode 激活时本插件整体让位。
- **平台心跳**：goal 处于 active+armed 且会话空闲时，宿主自带的 goal-round-driver 自动注入续跑轮（等子代理收尾、用户插话即暂停、轮预算耗尽置 blocked）。控制器无需轮询，`loop_pause` 解除心跳。
- **全链路观测**：每个事件落逐会话 append-only 审计流水 `<workspace>/.loop-mode/audit-<sessionId>.jsonl`（模式/goal 生命周期/平台轮次/委派与结算/验收与 verdict/修订/门禁拒绝），写入 best-effort 永不抛错。`/loop report` 聚合输出测量报告 + 确定性改进信号（通过率偏低、gap 重复、硬门高频拒绝、多轮无验收、修订频繁）。

## 角色与模型路由

| 角色 | 结构承载 | 模型配置 |
|---|---|---|
| 控制器（会话本身） | 硬门约束 | DSH 模型选择器自管 |
| 通用执行者 | `loop_task tier=general` | `generalModel` / `generalEffort` |
| 高级执行者 | `loop_task tier=senior` | `seniorModel` / `seniorEffort` |
| 验收者 | `loop_verify`（插件署名提示词 + schema 强制） | `verifyModel` / `verifyEffort` |
| triage | 折叠进控制器校准决策（简化取舍） | — |

全部字段在 Web「插件」页的**设置卡片**上就地编辑（volatile，保存即时生效），或经 profile `cordis.patch.yml` 配置：

```yaml
- id: dsh-loop-mode
  config:
    defaultOn: false          # 全局默认（未 /loop 的会话继承）
    gate: true                # 模式开启期间是否装配硬门
    maxRounds: 3              # 每目标矫正轮上限（写入 maxGoalRounds）
    generalModel: ''          # 通用执行者路由（"provider/model"，''=继承）
    generalEffort: ''
    seniorModel: ''           # 高级执行者路由
    seniorEffort: ''
    verifyModel: ''           # 验收者路由（可与执行者不同）
    verifyEffort: ''
    quickVerifyBudget: 3      # 每 goal quick 预算，用尽强制 full
    loopPresetId: loop        # 视为默认开启的 Agent 预设 id
    delegateProvider: ''      # subagent provider（缺省按能力自动选择）
    gateAllowlistExtra: []    # 硬门 allowlist 追加（如调研场景放行 web_fetch）
    commandName: loop         # 斜杠命令名
```

路由语义：配置后由插件在委派时以 `agentOptions` 结构性附带；配错（provider/model 不在宿主实时目录）在首次委派时显式报错，绝不静默换模型。

## LOOP 模式 Agent 预设

`presets/loop.patch.yml` 声明了一个与宿主 standard 同组合的 `loop` 预设（注册表无继承语义，组合为显式克隆，升级宿主后需手动同步）。预设不重复挂载本插件——插件读取宿主 `agentPreset` 会话投影，选择了 LOOP 模式预设的会话即默认开模式，优先级：`/loop` override > 会话预设身份 > 全局 `defaultOn`。

## 离线测试

```bash
node test/smoke.mjs         # 43 项：纯逻辑 + mock 宿主装配链路（mock 复刻宿主注册期校验）
node test/client-smoke.mjs  # 5 项：客户端设置卡片接线
```

## 与 dsh-cybernetics 的差异

| | dsh-cybernetics | dsh-loop-mode |
|---|---|---|
| 默认状态 | 安装即激活硬门 + 基础引导 | **完全惰性**，预设/`/loop` 是唯一入口 |
| 自建工具 | `cybernetics` 工具（goal 板/轮次驱动） | 五个会话接缝工具：loop_task / loop_revise / loop_verify / loop_pause / loop_resume |
| 执行引擎 | workflow 引擎跑每轮 | 无引擎依赖——直接 subagent 委派 + 平台续跑驱动 |
| goal 管理 | 自有多 goal 板 | 宿主 goal 服务单槽 + clear→create 修订链（append-only，审计入会话日志） |
| 验收隔离 | workflow 隔离层 | 插件署名提示词（nonce 围栏防注入）+ outputSchema 强制 + 防篡改节奏台账 |
| triage | 独立 triage agent | 折叠进控制器 |
| 客户端 UI | 目标/控制页签、徽标 | 插件页设置卡片 |
| 智能选模/预置方案/审批透传 | 有 | 无 |

## 已知边界

- **宿主接缝假设**：`system-prompt/assemble` 与 `tools/pre-execute` 事件契约、section 回调上下文（已做 `agent.session`/`scope.session` 双读）沿用 dsh-cybernetics 的用法（该插件真机验证过）；本插件已在真机完成一轮全链路验证（工具注册、委派、结算捕获、verdict 解析、审计落盘、预设激活），续跑心跳路径尚未在真实长任务中触发。
- **门禁残余通道**：allowlist 默认不含 web_fetch/web_search/skill（GET 副作用/SSRF/指令载荷面），需要时经 `gateAllowlistExtra` 恢复。
- **plan 叠加期**：plan mode 激活期间本插件硬门整体让位（门由 dsh-plan-mode 自理）。
- quick/full 预算按 goal 累计（非"连续"）：full 通过后不清零；新 goal 预算自然重置，轮上限钳制到部署 maxRounds。
- 验收独立性 = 插件署名提示词 + fresh 上下文 + schema 强制，无 workflow 隔离层；证据全由执行者生成时验收质量仍受证据本身限制。
- 审计文件无轮转上限。

## 许可

MIT。图标位于 `docs/icon.png`。
