# Cline 架构指南

> Cline 作为 VS Code 插件，直接在用户本机环境中运行，无法使用 Docker/VM 等物理隔离手段。本文档从 **沙箱安全架构**、**Sub Agent 多代理架构** 和 **异常处理与容错机制** 三个维度，详细描述 Cline 的核心设计。

## 目录

- [Cline 架构指南](#cline-架构指南)
  - [目录](#目录)
- [一、Cline 沙箱安全架构](#一cline-沙箱安全架构)
  - [架构总览](#架构总览)
  - [1. 工具调用协议](#1-工具调用协议)
    - [1.1 系统提示词定义工具规范](#11-系统提示词定义工具规范)
    - [1.2 LLM 输出 XML 格式的工具调用](#12-llm-输出-xml-格式的工具调用)
    - [1.3 流式解析](#13-流式解析)
    - [1.4 路由与执行](#14-路由与执行)
  - [2. 五层安全防线](#2-五层安全防线)
    - [2.1 命令权限控制（CommandPermissionController）](#21-命令权限控制commandpermissioncontroller)
    - [2.2 文件访问控制（ClineIgnoreController）](#22-文件访问控制clineignorecontroller)
    - [2.3 自动批准网关（AutoApprove）](#23-自动批准网关autoapprove)
    - [2.4 人工审批](#24-人工审批)
    - [2.5 检查点系统（CheckpointTracker）](#25-检查点系统checkpointtracker)
  - [3. 命令执行链路](#3-命令执行链路)
    - [3.1 ExecuteCommandToolHandler](#31-executecommandtoolhandler)
    - [3.2 VscodeTerminalManager](#32-vscodeterminalmanager)
    - [3.3 CommandOrchestrator](#33-commandorchestrator)
    - [3.4 ITerminalManager 接口抽象](#34-iterminalmanager-接口抽象)
  - [4. 文件操作安全](#4-文件操作安全)
  - [5. 设计哲学](#5-设计哲学)
- [二、Sub Agent 多代理架构](#二sub-agent-多代理架构)
  - [1. 架构组件](#1-架构组件)
  - [2. Agent 类型](#2-agent-类型)
  - [3. 创建时机与触发链路](#3-创建时机与触发链路)
  - [4. 通信模型](#4-通信模型)
  - [5. 隔离与安全约束](#5-隔离与安全约束)
  - [6. 自定义 Agent 配置](#6-自定义-agent-配置)
  - [7. 设计哲学](#7-设计哲学)
- [三、异常处理与容错机制](#三异常处理与容错机制)
  - [1. API 流中断与网络波动](#1-api-流中断与网络波动)
    - [1.1 流初始化失败（首个 chunk 阶段）](#11-流初始化失败首个-chunk-阶段)
    - [1.2 流中途失败（已接收部分内容后）](#12-流中途失败已接收部分内容后)
    - [1.3 UI 不卡死的保证](#13-ui-不卡死的保证)
  - [2. LLM 响应超时处理](#2-llm-响应超时处理)
    - [2.1 Provider 层超时检测](#21-provider-层超时检测)
    - [2.2 流中途卡住（无自动 Watchdog）](#22-流中途卡住无自动-watchdog)
    - [2.3 超时恢复路径](#23-超时恢复路径)
  - [3. 工具调用失败与 ReAct 循环](#3-工具调用失败与-react-循环)
    - [3.1 错误捕获与格式化](#31-错误捕获与格式化)
    - [3.2 错误反馈给 LLM 的机制](#32-错误反馈给-llm-的机制)
    - [3.3 LLM 自主决策重试](#33-llm-自主决策重试)
    - [3.4 防止无限循环的保护机制](#34-防止无限循环的保护机制)
  - [4. 设计哲学](#4-设计哲学)

---

# 一、Cline 沙箱安全架构

Cline 采用 **纵深防御（Defense in Depth）** 策略——通过多层逻辑安全层 + 检查点回滚来保障安全。

## 架构总览

```
LLM 流式响应
  → parseAssistantMessageV2 解析 XML 工具调用
  → ToolExecutorCoordinator 路由到对应 Handler
  → 安全检查层（权限 + 文件访问 + 自动批准 + 人工审批）
  → 命令执行 / 文件操作
  → CheckpointTracker 创建检查点
  → 输出反馈给 LLM
```

---

## 1. 工具调用协议

Cline 不依赖 LLM 的原生 function calling，而是定义了一套 **自定义 XML 工具协议**。

### 1.1 系统提示词定义工具规范

每个工具（如 `read_file`、`execute_command`）在系统提示词中声明名称、参数和用法说明。

- 关键文件：`src/core/prompts/system-prompt/tools/` 目录下各工具定义文件

### 1.2 LLM 输出 XML 格式的工具调用

LLM 不会输出 `cat` 等命令行来读文件，而是输出 Cline 自定义的 XML 标签：

```xml
<read_file>
<path>src/index.ts</path>
</read_file>
```

### 1.3 流式解析

`parseAssistantMessageV2` 对 LLM 的流式响应进行 **单遍扫描**，实时提取 XML 工具调用标签，输出 `TextContent`（普通文本）和 `ToolUse`（工具调用）两种内容块。

- 关键文件：`src/core/assistant-message/parse-assistant-message.ts`

### 1.4 路由与执行

`ToolExecutorCoordinator` 维护 `toolHandlersMap`（工具名 → 处理器工厂），将解析出的 `ToolUse` 分发到对应的 `ToolHandler` 执行。

- 关键文件：
  - `src/core/task/tools/ToolExecutorCoordinator.ts`（路由）
  - `src/core/task/ToolExecutor.ts`（执行引擎，处理部分块/完整块、拒绝检查、错误处理）

---

## 2. 五层安全防线

### 2.1 命令权限控制（CommandPermissionController）

通过环境变量 `CLINE_COMMAND_PERMISSIONS` 配置 allow/deny 规则，在命令到达终端之前进行拦截。

**核心能力：**
- 支持 allow/deny 通配符模式匹配
- 链式命令（`&&`、`||`、`;`、`|`）逐段验证
- 危险字符检测：换行符注入（`\n`）、反引号命令替换（`` ` ``）
- 重定向拦截（`>`、`>>`），通过 `allowRedirects` 开关控制
- 使用 `shell-quote` 库解析命令，防止引号逃逸

**关键文件：**
- `src/core/permissions/CommandPermissionController.ts`
- `src/core/permissions/types.ts`

### 2.2 文件访问控制（ClineIgnoreController）

基于项目根目录的 `.clineignore` 文件（gitignore 语法），控制 Cline 可以访问哪些文件。

**核心能力：**
- 使用 `ignore` 库支持完整的 gitignore 语法
- 通过 `chokidar` 监听文件变化，支持热更新
- 不仅验证直接文件操作（读/写），还通过 `validateCommand()` 检查 shell 命令参数中的文件路径
- 支持 `!include` 反向包含指令

**关键文件：**
- `src/core/ignore/ClineIgnoreController.ts`

### 2.3 自动批准网关（AutoApprove）

三级权限体系，控制工具是否需要人工确认：

| 级别 | 说明 |
|------|------|
| **YOLO 模式** | 所有工具自动批准，无需人工干预 |
| **全部批准** | 按工具类别统一配置 |
| **细粒度控制** | 对每种工具类型（读文件/写文件/执行命令等）单独配置 |

返回 `[safeApproved, allApproved]` 布尔元组：
- `safeApproved`：模型认为安全的操作是否自动批准
- `allApproved`：模型认为有风险的操作是否也自动批准

**关键文件：**
- `src/core/task/tools/autoApprove.ts`

### 2.4 人工审批

当自动批准未通过时，通过 VS Code 通知弹窗请求用户确认。用户可以：
- 批准执行
- 拒绝操作（返回 `toolDenied` 给 LLM）
- 提供反馈文本

### 2.5 检查点系统（CheckpointTracker）

基于 **影子 Git 仓库** 的文件状态快照机制，支持一键回滚。

**核心设计：**
- 在项目的 `.cline/checkpoints/` 下初始化独立的 Git 仓库
- 通过 `core.worktree` 配置指向实际工作目录
- 每次工具 **执行成功后** 自动创建 Git commit 作为检查点
- 回滚通过 `git reset --hard` 恢复到指定检查点
- 使用文件锁（`proper-lockfile`）防止多任务实例冲突

**为什么在执行后保存而非执行前？**
- "操作 N 之前" 等价于 "操作 N-1 之后"，执行前保存会产生冗余快照
- 只有成功的操作才产生检查点
- 与 Git 的设计哲学一致：commit 记录已完成的状态

**关键文件：**
- `src/integrations/checkpoints/CheckpointTracker.ts`（影子 Git 操作）
- `src/integrations/checkpoints/index.ts`（TaskCheckpointManager）
- `src/integrations/checkpoints/CheckpointGitOperations.ts`（Git 仓库初始化）

---

## 3. 命令执行链路

当 `execute_command` 工具通过所有安全检查后，命令沿以下链路执行：

```
ExecuteCommandToolHandler.execute()
  → config.callbacks.executeCommandTool(command, timeout)
  → Task.executeCommandTool()
  → CommandExecutor.execute()
  → VscodeTerminalManager.runCommand()  // 或 StandaloneTerminalManager
  → VscodeTerminalProcess.run()
  → CommandOrchestrator 编排输出
  → 反馈给 LLM
```

### 3.1 ExecuteCommandToolHandler

工具处理器层的命令入口，串联完整安全链：

1. 参数校验（`command`、`requires_approval`）
2. 模型特定修复（如 Gemini 内容修复）
3. 多工作区路径解析（`@backend:npm install` 语法）
4. `CommandPermissionController.validateCommand()` — 权限验证
5. `ClineIgnoreController.validateCommand()` — 文件访问验证
6. 自动批准 / 人工审批
7. PreToolUse Hook 执行
8. 调用 `executeCommandTool` 回调执行命令
9. 执行后清空 `fileReadCache`（命令可能修改了文件）

- 关键文件：`src/core/task/tools/handlers/ExecuteCommandToolHandler.ts`

### 3.2 VscodeTerminalManager

安全审批通过后的 **命令执行引擎**，负责终端管理和命令执行。

**核心能力：**

| 能力 | 说明 |
|------|------|
| 终端池化复用 | 优先匹配同 CWD + 同 Shell + 空闲的终端，支持通过 `cd` 复用 |
| Shell Integration 适配 | 优先使用 `shellIntegration.executeCommand()` 结构化捕获输出；不可用时降级为 `sendText()` |
| 优雅降级 | Shell Integration 超时（默认 4s）后自动降级，终端标记为不可复用 |
| 输出截断 | `processOutput()` 默认 500 行上限，超限时保留首尾各一半 |
| 终端 Profile 管理 | 支持切换默认终端 Shell，自动关闭旧 Shell 的空闲终端 |

- 关键文件：
  - `src/hosts/vscode/terminal/VscodeTerminalManager.ts`
  - `src/hosts/vscode/terminal/VscodeTerminalProcess.ts`（输出捕获与清洗）
  - `src/hosts/vscode/terminal/VscodeTerminalRegistry.ts`（终端注册表）

### 3.3 CommandOrchestrator

通用的命令输出编排逻辑，处理执行过程中的用户交互：

- 实时监听进程 `line` 事件，缓冲输出
- 分块刷新机制（2KB 阈值），定期向 UI 推送输出
- 支持 "Proceed While Running"（继续执行）和取消操作
- 调用 `terminalManager.processOutput()` 格式化最终输出
- 通过 `callbacks.say('command_output', result)` 将结果反馈给 LLM

- 关键文件：`src/integrations/terminal/CommandOrchestrator.ts`

### 3.4 ITerminalManager 接口抽象

`VscodeTerminalManager` 和 `StandaloneTerminalManager` 都实现 `ITerminalManager` 接口，安全策略不依赖具体终端实现。Task 在初始化时根据执行模式选择：

- `vscodeTerminal` 模式 → `VscodeTerminalManager`（VS Code 集成终端，用户可见）
- `backgroundExec` 模式 → `StandaloneTerminalManager`（后台隐藏执行）

- 关键文件：
  - `src/integrations/terminal/types.ts`（接口定义）
  - `src/integrations/terminal/CommandExecutor.ts`（统一协调器）

---

## 4. 文件操作安全

以 `read_file` 为例，文件工具的执行链同样贯穿安全层：

```
ReadFileToolHandler.execute()
  → 参数校验（path 必填）
  → ClineIgnoreController 检查文件访问权限
  → 路径解析（相对路径 → 绝对路径）
  → 自动批准 / 人工审批
  → PreToolUse Hook
  → 去重缓存检查（fileReadCache，基于 mtime）
  → 读取文件内容
  → 格式化输出（带行号，默认 1000 行截断）
```

**去重缓存机制：** `fileReadCache` 只存储文件路径和 `mtime`，当模型重复请求读取同一未修改文件时，返回提示信息而非重复读取，节省 Token。

- 关键文件：`src/core/task/tools/handlers/ReadFileToolHandler.ts`

---

## 5. 设计哲学

| 原则 | 实现 |
|------|------|
| **纵深防御** | 5 层安全检查，任一层拒绝即终止 |
| **用户始终可控** | 自动批准可关闭，人工审批兜底，终端输出实时可见 |
| **可回滚** | 检查点系统支持一键恢复到任意历史状态 |
| **优雅降级** | Shell Integration 不可用时自动降级，确保兼容性 |
| **接口抽象** | 安全策略与终端实现解耦，支持 VS Code / CLI / 后台等多种执行模式 |
| **Token 保护** | 输出截断 + 文件去重缓存，防止上下文窗口溢出 |

---

# 二、Sub Agent 多代理架构

Cline 实现了主从式多代理架构，主 Agent 可按需生成 Sub Agent 进行并行探索，避免消耗主上下文窗口。

## 1. 架构组件

| 组件 | 文件 | 职责 |
|------|------|------|
| **AgentConfigLoader** | `src/core/task/tools/subagent/AgentConfigLoader.ts` | 单例，从 `~/Documents/Cline/Agents/*.yaml` 加载自定义 Agent 配置，chokidar 热重载 |
| **SubagentBuilder** | `src/core/task/tools/subagent/SubagentBuilder.ts` | 为 Sub Agent 创建独立 API Handler、解析工具集、生成系统提示词 |
| **SubagentRunner** | `src/core/task/tools/subagent/SubagentRunner.ts` | 执行 Sub Agent 独立对话循环，管理工具调用、Token 跟踪、上下文压缩 |
| **UseSubagentsToolHandler** | `src/core/task/tools/handlers/SubagentToolHandler.ts` | `use_subagents` 工具入口，编排并行执行与结果汇总 |

---

## 2. Agent 类型

Cline 有 **2 种核心执行引擎**（Task 和 SubagentRunner），从功能角色看有 **4 种 Agent 模式**：

| 类型 | 实现 | 说明 |
|------|------|------|
| **主 Agent** | `Task` 类（`src/core/task/index.ts`） | 核心执行单元，处理用户请求，拥有所有工具访问权限 |
| **Plan 模式** | `PlanModeRespondHandler` | 主 Agent 的规划行为变体，只能对话式规划，不执行操作 |
| **Act 模式** | `ActModeRespondHandler` | 主 Agent 的执行行为变体，可调用所有工具 |
| **Sub Agent** | `SubagentRunner` | 轻量级研究型代理，受限工具集，独立对话循环 |

此外，用户可通过 YAML 配置文件定义 **自定义 Agent**（特化的 Sub Agent），每种可配置独立的名称、工具集、系统提示词和模型。

---

## 3. 创建时机与触发链路

**谁决定何时创建？** 不是代码逻辑决定，而是 LLM 模型根据系统提示词中的工具描述自主决策。

系统提示词（`src/core/prompts/system-prompt/tools/subagent.ts`）告知 LLM 在以下场景使用：
- 需要广泛探索代码库，直接读取大量文件会消耗主上下文窗口时
- 需要并行执行多个独立调研任务时
- 轻量级发现工作，想避免不必要的上下文占用时

**前置条件：** `subagentsEnabled === true` 且当前不在 Sub Agent 内部（禁止嵌套）。

**创建链路：**

```
LLM 输出 use_subagents 工具调用
  → Task.presentAssistantMessage()          // 识别 tool_use 块
  → ToolExecutor.executeTool(block)         // 工具执行入口
  → ToolExecutorCoordinator.execute()       // 路由到 Handler
  → UseSubagentsToolHandler.execute()       // 收集 prompts、请求审批
  → new SubagentRunner() × N               // 创建 1~5 个运行器
    → new SubagentBuilder()                 // 构建 API Handler、工具集、系统提示
  → Promise.allSettled(runners.map(run))    // 并行执行
  → 汇总结果 → 返回 ToolResponse 文本       // 回传给主 LLM
```

---

## 4. 通信模型

Sub Agent 与主 Agent 的通信本质上等同于一次 **封装式异步工具调用**——从主 LLM 的视角看，调用 `use_subagents` 和调用 `read_file` 没有区别，都是发出请求、等待文本结果返回。

```
主 Agent:  [思考] → [调用 use_subagents] → [阻塞等待...] → [拿到文本摘要，继续]
                                               ↓
Sub Agent 1:                        [独立LLM对话 → 工具调用 → attempt_completion]
Sub Agent 2:                        [独立LLM对话 → 工具调用 → attempt_completion]
```

**关键特性：**
- **主 LLM 阻塞等待**：`await Promise.allSettled()` 期间主 Agent 完全暂停
- **结果为纯文本摘要**：Sub Agent 内部的完整对话历史和工具调用细节对主 LLM 不可见
- **进度通过回调上报**：`onProgress` 回调实时上报状态、最新工具调用、Token 统计
- **中止级联**：主 Agent 的 `taskState.abort` 标志每 100ms 轮询传递给所有 Sub Agent
- **Sub Agent 之间不直接通信**：协作完全依赖主 Agent 作为中央协调者

---

## 5. 隔离与安全约束

每个 Sub Agent 通过 `createSubagentTaskConfig` 创建完全独立的执行上下文：

| 维度 | 隔离方式 |
|------|--------|
| **TaskState** | 每个 Sub Agent 独立实例 |
| **ContextManager** | 独立的上下文窗口管理和对话历史截断 |
| **ToolExecutorCoordinator** | 独立实例，只注册允许的工具 |
| **API Handler** | 独立实例（共享 Provider 和 API Key，可通过 YAML 覆盖 modelId） |
| **对话历史** | 完全独立，不与主 Agent 共享 |

**工具限制：** Sub Agent 默认只能使用 7 种安全工具：

```
read_file, list_files, search_files, list_code_definition_names,
execute_command, use_skill, attempt_completion
```

**其他安全措施：**
- `say` 回调被静默（`async () => undefined`），Sub Agent 不直接向用户展示消息
- 命令执行强制后台模式（`useBackgroundExecution: true, suppressUserInteraction: true`）
- 禁止嵌套调用 `use_subagents`（通过 `isSubagentRun` 标志控制）

---

## 6. 自定义 Agent 配置

用户可在 `~/Documents/Cline/Agents/` 目录下创建 YAML 文件定义特化 Agent：

```yaml
---
name: code-reviewer
description: 专注代码审查的 Agent
modelId: claude-sonnet-4-20250514
tools: read_file, search_files, list_code_definition_names
skills: review-skill
---
你是一个代码审查专家，专注于发现代码中的潜在问题...
```

自定义 Agent 会被注册为动态工具（如 `use_subagent_code_reviewer`），主 LLM 可在系统提示词中看到并直接调用。配置文件变更时通过 `chokidar` 自动热重载。

---

## 7. 设计哲学

| 原则 | 实现 |
|------|------|
| **Sub Agent 隔离** | 独立 TaskState / 对话历史 / 工具集，受限工具 + 禁止嵌套 + 静默 UI |
| **上下文窗口保护** | Sub Agent 承担探索性工作，结果以文本摘要回传，避免主 Agent 上下文膨胀 |

---

# 三、异常处理与容错机制

Cline 作为一个重度依赖网络和 LLM 服务的代理系统，必须在各种异常场景下保持健壮。本章围绕以下常见问题展开：

> **Q1**：如果 AI 输出中断或网络波动，导致中间流程执行中断了，这时会发生什么？如何确保用户界面不会卡死？
>
> **Q2**：如果某个内置的 Tool 调用失败了，那么会发生什么？在 ReAct 循环里，大模型会重新执行同样的 tool_use 吗？
>
> **Q3**：如果因为网络波动，导致 LLM 返回内容超时，那么 Cline 会如何处理？

---

## 1. API 流中断与网络波动

Cline 对流中断的处理分为 **两个阶段**，行为截然不同：

### 1.1 流初始化失败（首个 chunk 阶段）

在 `attemptApiRequest()` 中，系统通过 `isWaitingForFirstChunk` 标志区分是否已开始接收流数据：

```
attemptApiRequest()
  → isWaitingForFirstChunk = true
  → await iterator.next()          // 等待第一个 chunk
  → isWaitingForFirstChunk = false  // 成功接收
  → catch(error)                    // 失败则进入重试流程
```

如果第一个 chunk 就失败（如网络超时、API 限流等），进入自动重试流程：

1. **自动重试**：最多 3 次，指数退避延迟（2s → 4s → 8s），在 UI 显示重试倒计时
2. **手动重试**：3 次自动重试耗尽后，调用 `ask("api_req_failed", ...)` 弹出对话框让用户决定是否继续
3. **上下文窗口超出**：如果是 context window exceeded 错误，会自动截断对话历史后重试

注意：认证错误、余额不足和支出限额错误 **不会自动重试**，会直接提示用户。

**关键文件：**
- `src/core/task/index.ts`（`attemptApiRequest()` 方法）
- `src/core/task/TaskState.ts`（`autoRetryAttempts`、`isWaitingForFirstChunk` 状态）

### 1.2 流中途失败（已接收部分内容后）

当流已开始传输但中途断开时，处理更复杂，因为此时可能已有工具被解析并执行：

```
流中途报错
  → catch(error) 在主流处理循环中捕获
  → streamCoordinator.stop()                // 停止流
  → ErrorService.toClineError(error)         // 转换为标准化错误
  → 自动重试（同样 3 次指数退避）
  → abortStream("streaming_failed", error)   // 保存已接收的部分响应
  → reinitExistingTaskFromId(taskId)          // 重新初始化任务实例
```

`abortStream()` 的关键设计：将已接收的部分助手响应保存到 API 对话历史，并追加标记 `[Response interrupted by API Error]`，便于任务恢复时 LLM 能理解上下文。

**关键文件：**
- `src/core/task/index.ts`（主流处理 try-catch 块）
- `src/core/task/StreamChunkCoordinator.ts`（流数据块协调器）

### 1.3 UI 不卡死的保证

无论哪种异常场景，UI 都不会卡死，核心保障机制：

1. **`finally` 块无条件重置流状态**：无论是否报错，`isStreaming` 标志都会在 `finally` 块中被设为 `false`，确保 UI 不会永远停留在“等待流响应”状态
2. **异步非阻塞**：流处理运行在异步 Promise 中，不阻塞 VS Code 主线程，用户始终可以操作界面
3. **持续中止检查**：流处理循环每个 chunk 间隔检查 `taskState.abort`、`didRejectTool`、`didAlreadyUseTool` 等标志，确保能及时响应中止命令
4. **用户随时可取消**：用户点击取消按钮后，`abort` 标志置为 `true`，通过 `api.abort()` 触发 `AbortController` 强制断开底层 HTTP 连接

---

## 2. LLM 响应超时处理

> **问题背景：** 网络波动可能导致 LLM 响应延迟或完全超时，Cline 的超时检测分布在不同层次。

### 2.1 Provider 层超时检测

不同 API Provider 有各自的超时机制：

| Provider | 超时实现 | 默认超时 |
|----------|---------|--------|
| **Ollama** | `Promise.race([apiPromise, timeoutPromise])` 竞速 | 30 秒 |
| **OpenAI/Codex** | `AbortController.signal` 传入 SDK | 依赖 SDK 默认值 |
| **OpenRouter** | axios `timeout: 15_000`（特定请求） | 15 秒 |

当 Provider 层超时触发时，会抛出超时错误，然后被 `attemptApiRequest()` 的 catch 捕获，进入常规的自动重试流程（3 次指数退避）。

**关键文件：**
- `src/core/api/providers/ollama.ts`（`requestTimeoutMs` 配置）
- `src/core/api/providers/openai-native.ts`（`AbortController` 实现）
- `src/core/api/providers/openrouter.ts`（axios 超时配置）

### 2.2 流中途卡住（无自动 Watchdog）

**重要设计特点：** Cline 核心层 **没有** chunk 间的 watchdog/heartbeat 超时检测机制。

`StreamChunkCoordinator` 的 `startPump()` 通过 `await this.iterator.next()` 等待下一个数据块，这是一个 **无超时的 await**：

```typescript
// StreamChunkCoordinator.startPump()
while (!this.stopRequested) {
    const { value: chunk, done } = await this.iterator.next() // 无限等待
    if (done || !chunk) break
    // ...处理 chunk
}
```

这意味着：如果网络波动导致 TCP 连接 **未断开** 但数据就是不来（“半开”状态），流会无限期挂起。源码中也有相关注释承认这一已知问题：

> `// sometimes openrouter stream hangs, in which case this would affect future instances of cline`

> ℹ️ **可改进点：** 可在 `StreamChunkCoordinator` 中增加 chunk 间的 idle timeout，检测流停滞并自动触发错误恢复。

**关键文件：**
- `src/core/task/StreamChunkCoordinator.ts`（`startPump()` 方法）

### 2.3 超时恢复路径

当流中途卡住时，有三条可能的恢复路径：

```
流中途卡住（chunk 不来了）
  → Cline 核心层：无自动检测，持续等待
  → 可能的恢复路径：
    ├─ 路径 1：底层 SDK/HTTP 客户端自身的 socket timeout 触发
    │   → 抛出网络错误 → StreamChunkCoordinator.readError 被设置
    │   → nextChunk() 抛出错误 → 进入 catch 块 → 自动重试流程
    │
    ├─ 路径 2：用户手动点击取消
    │   → taskState.abort = true → api.abort() → AbortController 中断连接
    │   → abortStream("user_cancelled") → 保存中断状态
    │
    └─ 路径 3：操作系统层面 TCP keepalive 超时（通常几分钟）
        → socket 错误冒泡 → 同路径 1
```

| 超时场景 | 是否有自动检测 | 恢复方式 |
|----------|:----------:|--------|
| 第一个 chunk 超时 | ✅ Provider 层超时 | 自动重试 3 次 + 用户手动重试 |
| 流中途 chunk 停止 | ❌ 无 watchdog | 依赖底层 socket 超时或用户手动取消 |
| 流中途抛出网络错误 | ✅ catch 捕获 | 自动重试 3 次 + 用户手动重试 |

---

## 3. 工具调用失败与 ReAct 循环

> **核心问题：** 工具执行失败后，错误如何传递回 LLM？LLM 会自动重试吗？如何防止无限重试循环？

### 3.1 错误捕获与格式化

所有工具执行都被 `ToolExecutor.execute()` 的 try-catch 包裹：

```
工具执行抛异常
  → handleError("executing ${toolName}", error, block)
    → say("error", errorString)                      // 在 UI 显示错误
    → formatResponse.toolError(errorString)            // 生成标准化错误格式
    → pushToolResult(errorResponse, block)             // 推入 userMessageContent
```

`formatResponse.toolError()` 生成的标准格式：

```xml
The tool execution failed with the following error:
<error>
Error executing read_file: file not found
</error>
```

**关键文件：**
- `src/core/task/ToolExecutor.ts`（`handleError()`、`pushToolResult()`）
- `src/core/prompts/responses.ts`（`formatResponse.toolError()`）
- `src/core/task/tools/utils/ToolResultUtils.ts`（`pushToolResult()` 统一格式化）

### 3.2 错误反馈给 LLM 的机制

错误信息通过 ReAct 主循环 `recursivelyMakeClineRequests()` 反馈给 LLM：

```
Assistant 生成工具调用
  → Tool 执行失败
  → formatResponse.toolError(error) 生成错误消息
  → ToolResultUtils.pushToolResult() 推入 userMessageContent
  → 工具执行完成，等待 userMessageContentReady
  → addToApiConversationHistory() 将错误作为“用户消息”保存
  → recursivelyMakeClineRequests(userMessageContent)  // 发起下一轮请求
  → LLM 收到错误信息，自主决策下一步行动
```

从 LLM 的视角看，工具错误和工具成功返回的流程完全一样——都是作为 `tool_result` 块追加到下一轮用户消息中。

### 3.3 LLM 自主决策重试

**Cline 本身不会强制 LLM 重试同一个工具调用。** 它只是将错误信息作为“用户消息”反馈给 LLM，由 LLM 自主决定下一步行动。这是一个 **由 LLM 驱动的自适应重试机制**，而非代码层面的机械重试。

LLM 收到错误后可能的行为：
- **重试同一工具**（修正参数后），例如路径拼错后用正确路径重试
- **换用其他工具**，例如 `write_to_file` 失败后改用 `replace_in_file`
- **向用户请求帮助**，通过 `ask_followup_question`

### 3.4 防止无限循环的保护机制

Cline 通过多层保护防止 LLM 陷入重复失败的死循环：

**（1）重复工具调用检测**

`ToolExecutor` 中的 `checkRepeatedToolCall()` 跟踪连续相同工具+相同参数的调用次数：
- **软警告**（达到软阈值）：向 LLM 注入警告提示文本
- **硬升级**（达到硬阈值）：直接触发连续错误限制

**（2）连续错误计数**

`consecutiveMistakeCount` 达到 `maxConsecutiveMistakes` 阈值后：
- **普通模式**：暂停执行，弹窗请求用户介入指导
- **YOLO 模式**：直接终止任务，避免无监督下无限循环

**（3）特化错误提示（递进式引导）**

以 `write_to_file` 内容缺失为例，`writeToFileMissingContentError()` 根据连续失败次数逐步升级提示强度：

| 失败次数 | 提示策略 |
|----------|----------|
| 第 1 次 | 给出建议（拆分任务、使用 replace_in_file） |
| 第 2 次 | 强烈建议换方法，明确要求不要再尝试相同操作 |
| 第 3+ 次 | 直接要求停止使用该工具，提供替代方案的具体步骤 |

**关键文件：**
- `src/core/task/ToolExecutor.ts`（`checkRepeatedToolCall()`）
- `src/core/task/index.ts`（`consecutiveMistakeCount`、`maxConsecutiveMistakes`）
- `src/core/prompts/responses.ts`（`writeToFileMissingContentError()`、`noToolsUsed()`）

---

## 4. 设计哲学

| 原则 | 实现 |
|------|------|
| **分层容错** | Provider 层超时 → 核心层重试 → UI 层用户介入，每层有独立的恢复策略 |
| **指数退避** | 自动重试 3 次（2s/4s/8s），避免反复冒冲已超载的服务 |
| **LLM 自治** | 工具错误反馈给 LLM 而非代码强制重试，充分利用模型的推理能力自适应 |
| **递进式引导** | 工具错误提示随失败次数递增强度，从建议到强制要求 |
| **用户兜底** | 所有自动机制失败后，最终都会回退到用户手动决策 |
| **状态保存** | 流中断时保存部分响应和中断标记，支持任务恢复续传 |
