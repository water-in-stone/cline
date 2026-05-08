# ToolSystem

## 目录

- [ToolSystem](#toolsystem)
  - [目录](#目录)
  - [​ReadFileToolHandler 等工具是如何被大模型调用？](#readfiletoolhandler-等工具是如何被大模型调用)
  - [完整调用链路](#完整调用链路)
    - [1. 系统提示词告诉大模型有哪些工具](#1-系统提示词告诉大模型有哪些工具)
    - [2. 大模型输出自定义 XML 标签](#2-大模型输出自定义-xml-标签)
    - [3. 解析器提取工具调用](#3-解析器提取工具调用)
    - [4. 协调器路由到对应处理器](#4-协调器路由到对应处理器)
    - [5. 结果返回给大模型](#5-结果返回给大模型)
  - [总结：这是1套独立的工具协议](#总结这是1套独立的工具协议)

## ​ReadFileToolHandler 等工具是如何被大模型调用？

大模型返回的 tool\_use 里，应该只有 cat 等普通命令行吧？是否存在1个映射的过程？

好问题！大模型**不是**用 `cat` 命令读文件的，而是调用 Cline 自定义的 `read_file` 工具。
Cline 定义了一套**自己的工具协议**，大模型直接输出 XML 格式的工具调用。

## 完整调用链路

### 1. 系统提示词告诉大模型有哪些工具

在 [\[read\_file.ts\]](src/core/prompts/system-prompt/tools/read_file.ts "\[read_file.ts]") 中定义了工具规范，通过 [\[PromptBuilder\]](src/core/prompts/system-prompt/registry/PromptBuilder.ts "\[PromptBuilder]") 编译进系统提示词，大模型看到的是这样的：

```markdown 
## read_file
Description: Request to read the contents of a file...
Parameters:
- path: (required) The path of the file to read
- start_line: (optional) ...
- end_line: (optional) ...

Usage:
<read_file>
<path>File path here</path>
</read_file>
```


所以大模型**从一开始就知道**该用 `<read_file>` 而不是 `cat`。

### 2. 大模型输出自定义 XML 标签

大模型的回复是这样的原始文本：

```markdown 
Let me examine the main file.
<read_file>
<path>src/main.ts</path>
</read_file>
```


**不是** Anthropic API 的 `tool_use` JSON 格式，而是纯文本里嵌入的 XML 标签。

### 3. 解析器提取工具调用

[parseAssistantMessageV2](src/core/assistant-message/parse-assistant-message.ts "parseAssistantMessageV2") 用**单遍扫描**算法解析原始文本，识别 `<read_file>`、`<path>` 等标签，输出结构化对象：

```typescript 
[
  { type: "text", content: "Let me examine the main file." },
  { type: "tool_use", name: "read_file", params: { path: "src/main.ts" }, partial: false }
]
```


### 4. 协调器路由到对应处理器

[\[ToolExecutorCoordinator\]](file:///Users/baikal/Code/lab/cline/src/core/task/tools/ToolExecutorCoordinator.ts#L79-L109 "\[ToolExecutorCoordinator]") 维护了一张**名称 → 处理器**的映射表：

```typescript 
{
  "read_file"        → ReadFileToolHandler,
  "execute_command"   → ExecuteCommandToolHandler,
  "write_to_file"     → WriteToFileToolHandler,
  "browser_action"    → BrowserToolHandler,
  // ...20+ 工具
}
```


[\[ToolExecutor.execute()\]](\(file:///Users/baikal/Code/lab/cline/src/core/task/ToolExecutor.ts "\[ToolExecutor.execute()]")接收解析后的 block，通过 `coordinator.getHandler(block.name)` 找到 `ReadFileToolHandler`，调用其 `execute()` 方法。

### 5. 结果返回给大模型

处理器执行后，结果作为下一轮对话的 `tool_result` 发回给大模型：

```javascript 
1 | import React from 'react'
2 | import App from './App'
3 | ...

(File has 42 lines total.)
```


## 总结：这是1套独立的工具协议

```xml 
系统提示词定义工具 → 大模型输出 XML 工具调用 → 解析器提取 → 协调器路由 → 处理器执行
```


大模型**从来不会**用 `cat` 来读文件。`cat` 属于 `execute_command` 工具的范畴，而 `read_file` 是 Cline 自己定义的一个更高层的抽象——它比 `cat` 多了权限检查、行号标注、去重缓存、截断控制等能力。这也是为什么 Cline 能做到细粒度安全控制：**它控制了工具的定义和执行的整个生命周期**。
