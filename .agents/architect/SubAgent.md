# SubAgent

## 目录

- [二、Sub Agent 多代理架构](#二Sub-Agent-多代理架构)
  - [1. 架构组件](#1-架构组件)
  - [2. Agent 类型](#2-Agent-类型)
  - [3. 创建时机与触发链路](#3-创建时机与触发链路)
  - [4. 通信模型](#4-通信模型)
  - [5. 隔离与安全约束](#5-隔离与安全约束)
  - [6. 自定义 Agent 配置](#6-自定义-Agent-配置)
  - [7. 设计哲学](#7-设计哲学)

# 二、Sub Agent 多代理架构

Cline 实现了主从式多代理架构，主 Agent 可按需生成 Sub Agent 进行并行探索，避免消耗主上下文窗口。

## 1. 架构组件

| 组件                           | 文件                                                      | 职责                                                                  |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| **AgentConfigLoader**​       | \`src/core/task/tools/subagent/AgentConfigLoader.ts\`   | 单例，从 `~/Documents/Cline/Agents/ *.yaml` 加载自定义 Agent 配置，chokidar 热重载 |
| **SubagentBuilder**​         | \`src/core/task/tools/subagent/SubagentBuilder.ts\`     | 为 Sub Agent 创建独立 API Handler、解析工具集、生成系统提示词                          |
| **SubagentRunner**​          | \`src/core/task/tools/subagent/SubagentRunner.ts\`      | 执行 Sub Agent 独立对话循环，管理工具调用、Token 跟踪、上下文压缩                           |
| **UseSubagentsToolHandler**​ | \`src/core/task/tools/handlers/SubagentToolHandler.ts\` | \`use\_subagents\` 工具入口，编排并行执行与结果汇总                                 |

***

## 2. Agent 类型

Cline 有 **2 种核心执行引擎**（Task 和 SubagentRunner），从功能角色看有 **4 种 Agent 模式**：

| 类型             | 实现                                     | 说明                            |
| -------------- | -------------------------------------- | ----------------------------- |
| **主 Agent**​   | \`Task\` 类（\`src/core/task/index.ts\`） | 核心执行单元，处理用户请求，拥有所有工具访问权限      |
| **Plan 模式**​   | \`PlanModeRespondHandler\`             | 主 Agent 的规划行为变体，只能对话式规划，不执行操作 |
| **Act 模式**​    | \`ActModeRespondHandler\`              | 主 Agent 的执行行为变体，可调用所有工具       |
| **Sub Agent**​ | \`SubagentRunner\`                     | 轻量级研究型代理，受限工具集，独立对话循环         |

此外，用户可通过 YAML 配置文件定义 **自定义 Agent**（特化的 Sub Agent），每种可配置独立的名称、工具集、系统提示词和模型。

***

## 3. 创建时机与触发链路

**谁决定何时创建？** 不是代码逻辑决定，而是 LLM 模型根据系统提示词中的工具描述自主决策。

系统提示词（`src/core/prompts/system-prompt/tools/subagent.ts`）告知 LLM 在以下场景使用：

- 需要广泛探索代码库，直接读取大量文件会消耗主上下文窗口时
- 需要并行执行多个独立调研任务时
- 轻量级发现工作，想避免不必要的上下文占用时

**前置条件：** `subagentsEnabled === true` 且当前不在 Sub Agent 内部（禁止嵌套）。

**创建链路：**

```javascript 
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


***

## 4. 通信模型

Sub Agent 与主 Agent 的通信本质上等同于1次 **封装式异步工具调用**——从主 LLM 的视角看，调用 `use_subagents` 和调用 `read_file` 没有区别，都是发出请求、等待文本结果返回。

```markdown 
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

***

## 5. 隔离与安全约束

每个 Sub Agent 会创建完全独立的执行上下文：

| 维度                           | 隔离方式                                            |
| ---------------------------- | ----------------------------------------------- |
| **TaskState**​               | 每个 Sub Agent 独立实例                               |
| **ContextManager**​          | 独立的上下文窗口管理和对话历史截断                               |
| **ToolExecutorCoordinator**​ | 独立实例，只注册允许的工具                                   |
| **API Handler**​             | 独立实例（共享 Provider 和 API Key，可通过 YAML 覆盖 modelId） |
| **对话历史**​                    | 完全独立，不与主 Agent 共享                               |

**工具限制：** Sub Agent 默认只能使用 7 种安全工具：

```python 
read_file, list_files, search_files, list_code_definition_names,
execute_command, use_skill, attempt_completion
```


**其他安全措施：**

- `say` 回调被静默（`async () => undefined`），Sub Agent 不直接向用户展示消息
- 命令执行强制后台模式（`useBackgroundExecution: true, suppressUserInteraction: true`）
- 禁止嵌套调用 `use_subagents`（通过 `isSubagentRun` 标志控制）

***

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

***

## 7. 设计哲学

| 原则                | 实现                                            |
| ----------------- | --------------------------------------------- |
| **Sub Agent 隔离**​ | 独立 TaskState / 对话历史 / 工具集，受限工具 + 禁止嵌套 + 静默 UI |
| **上下文窗口保护**​      | Sub Agent 承担探索性工作，结果以文本摘要回传，避免主 Agent 上下文膨胀   |
