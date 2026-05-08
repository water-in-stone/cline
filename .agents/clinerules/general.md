本文件是在此代码库中高效工作的"秘密武器"。它记录了部落知识——那些微妙的、不显而易见的模式，它们决定了你是快速修复问题，还是花费数小时反复沟通并需要人工介入。

**何时向本文件添加内容：**
- 用户不得不介入、纠正或手把手指导
- 需要多次反复尝试才能让某个功能正常工作
- 你发现了需要阅读大量文件才能理解的内容
- 某个改动涉及了你意想不到的文件
- 某些东西的行为与你的预期不同
- 用户明确要求"将此添加到 CLAUDE.md"

当上述任何情况发生时，**主动建议添加内容**——不要等别人来问。

**不应该添加的内容：** 通过阅读几个文件就能弄清楚的东西、显而易见的模式或标准实践。本文件应该是高信噪比的，而不是面面俱到的。

## 杂项
- 这是一个 VS Code 扩展——在尝试验证构建之前，先查看 `package.json` 中可用的脚本（例如使用 `npm run compile`，而不是 `npm run build`）。
- 创建 PR 时，贡献者不应创建 changelog 条目文件。维护者会在发布过程中处理版本号和 changelog 的整理工作。
- 添加新的功能开关时，请参考此 PR：https://github.com/cline/cline/pull/7566
- 关于发起网络请求的额外说明：@.clinerules/network.md

## gRPC/Protobuf 通信
扩展和 webview 通过基于 VS Code 消息传递的类 gRPC 协议进行通信。

**Proto 文件位于 `proto/`**（例如 `proto/cline/task.proto`、`proto/cline/ui.proto`）
- 每个功能领域有自己的 `.proto` 文件
- 对于简单数据，使用 `proto/cline/common.proto` 中的共享类型（`StringRequest`、`Empty`、`Int64Request`）
- 对于复杂数据，在功能对应的 `.proto` 文件中定义自定义消息
- 命名规范：Services 使用 `PascalCaseService`，RPCs 使用 `camelCase`，Messages 使用 `PascalCase`
- 对于流式响应，使用 `stream` 关键字（参见 `account.proto` 中的 `subscribeToAuthCallback`）

**任何 proto 变更后运行 `npm run protos`**——生成的类型位于：
- `src/shared/proto/` - 共享类型定义
- `src/generated/grpc-js/` - 服务实现
- `src/generated/nice-grpc/` - 基于 Promise 的客户端
- `src/generated/hosts/` - 生成的处理器

**添加新的枚举值**（如新的 `ClineSay` 类型）需要更新 `src/shared/proto-conversions/cline-message.ts` 中的转换映射

**添加新的 RPC 方法**需要：
- 在 `src/core/controller/<domain>/` 中添加处理器
- 从 webview 通过生成的客户端调用：`UiServiceClient.scrollToSettings(StringRequest.create({ value: "browser" }))`

**示例——`explain-changes` 功能涉及的文件：**
- `proto/cline/task.proto` - 添加了 `ExplainChangesRequest` 消息和 `explainChanges` RPC
- `proto/cline/ui.proto` - 在 `ClineSay` 枚举中添加了 `GENERATE_EXPLANATION = 29`
- `src/shared/ExtensionMessage.ts` - 添加了 `ClineSayGenerateExplanation` 类型
- `src/shared/proto-conversions/cline-message.ts` - 为新的 say 类型添加了映射
- `src/core/controller/task/explainChanges.ts` - 处理器实现
- `webview-ui/src/components/chat/ChatRow.tsx` - UI 渲染

## 添加新的 API Provider
添加新的 provider（例如 "openai-codex"）时，你必须在三个地方更新 proto 转换层，否则 provider 会静默重置为 Anthropic：

1. `proto/cline/models.proto` - 添加到 `ApiProvider` 枚举（例如 `OPENAI_CODEX = 40;`）
2. `src/shared/proto-conversions/models/api-configuration-conversion.ts` 中的 `convertApiProviderToProto()` - 添加字符串到 proto 枚举的映射
3. 同一文件中的 `convertProtoToApiProvider()` - 添加 proto 枚举回字符串的映射

**为什么这很重要：** 如果不做这些，provider 字符串会命中 `default` 分支并返回 `ANTHROPIC`。webview、provider 列表和处理器都能正常工作，但状态在经过 proto 序列化往返时会静默重置。不会抛出任何错误。

**添加 provider 时还需更新的其他文件：**
- `src/shared/api.ts` - 添加到 `ApiProvider` 联合类型，定义模型
- `src/shared/providers/providers.json` - 添加到下拉列表的 provider 列表
- `src/core/api/index.ts` - 在 `createHandlerForProvider()` 中注册处理器
- `webview-ui/src/components/settings/utils/providerUtils.ts` - 在 `getModelsForProvider()` 和 `normalizeApiConfiguration()` 中添加 case
- `webview-ui/src/utils/validate.ts` - 添加验证 case
- `webview-ui/src/components/settings/ApiOptions.tsx` - 渲染 provider 组件

## Responses API Provider（OpenAI Codex、OpenAI Native）
使用 OpenAI Responses API 的 provider 需要原生工具调用。XML 工具与 Responses API 不兼容。

**原生工具调用异常的症状：**
- 工具被多次调用（例如 `ask_followup_question` 重复问同一个问题两次）
- 工具参数被重复或格式错误
- 模型有响应但工具未被识别

**需要排查的根本原因：**
1. **Provider 未添加到 `isNextGenModelProvider()`**（位于 `src/utils/model-utils.ts`）。原生变体匹配器（例如 `native-gpt-5/config.ts`）会调用此函数。如果你的 provider 不在列表中，匹配器返回 false 并回退到 XML 工具。

2. **模型缺少 `apiFormat: ApiFormat.OPENAI_RESPONSES`**（在其模型信息中，`src/shared/api.ts`）。此属性表示模型需要原生工具调用。`src/core/task/index.ts` 中的 task runner 会检查此项，并强制设置 `enableNativeToolCalls: true`，无论用户设置如何。

**添加新的 Responses API provider 时：**
1. 将 provider 添加到 `src/utils/model-utils.ts` 中的 `isNextGenModelProvider()` 列表
2. 在所有使用 Responses API 的模型上设置 `apiFormat: ApiFormat.OPENAI_RESPONSES`
3. 变体匹配器和 task runner 会自动处理其余部分

## 向系统提示词添加工具
这很棘手——涉及多个 prompt 变体和配置。**务必先搜索已有的类似工具并遵循它们的模式。** 在实现之前，查看从 prompt 定义 → 变体配置 → 处理器 → UI 的完整链路。

1. **添加到 `ClineDefaultTool` 枚举**（位于 `src/shared/tools.ts`）
2. **工具定义**（位于 `src/core/prompts/system-prompt/tools/`，创建类似 `generate_explanation.ts` 的文件）
   - 为每个 `ModelFamily` 定义变体（generic、next-gen、xs 等）
   - 导出变体数组（例如 `export const my_tool_variants = [GENERIC, NATIVE_NEXT_GEN, XS]`）
   - **回退行为**：如果某个模型族没有定义对应的变体，`ClineToolSet.getToolByNameWithFallback()` 会自动回退到 GENERIC。因此，除非工具需要模型特定的行为，否则只需导出 `[GENERIC]`
3. **在 `src/core/prompts/system-prompt/tools/init.ts` 中注册** - 导入并展开到 `allToolVariants`
4. **添加到变体配置** - 每个模型族在 `src/core/prompts/system-prompt/variants/*/config.ts` 中有自己的配置。将你的工具枚举添加到 `.tools()` 列表：
   - `generic/config.ts`、`next-gen/config.ts`、`gpt-5/config.ts`、`native-gpt-5/config.ts`、`native-gpt-5-1/config.ts`、`native-next-gen/config.ts`、`gemini-3/config.ts`、`glm/config.ts`、`hermes/config.ts`、`xs/config.ts`
   - **重要**：如果你添加到某个变体的配置中，确保工具规格导出了该 ModelFamily 的变体（或依赖 GENERIC 回退）
5. **创建处理器**（位于 `src/core/task/tools/handlers/`）
6. **在 `ToolExecutor.ts` 中接入**（如果执行流程需要的话）
7. **添加到工具解析**（位于 `src/core/assistant-message/index.ts`，如果需要的话）
8. **如果工具有 UI 反馈**：在 proto 中添加 `ClineSay` 枚举，更新 `src/shared/ExtensionMessage.ts`，更新 `src/shared/proto-conversions/cline-message.ts`，更新 `webview-ui/src/components/chat/ChatRow.tsx`

## 修改系统提示词
**先阅读这些文档：** `src/core/prompts/system-prompt/README.md`、`tools/README.md`、`__tests__/README.md`

系统提示词是模块化的：**组件（components）**（可复用的片段）+ **变体（variants）**（模型特定的配置）+ **模板（templates）**（使用 `{{PLACEHOLDER}}` 占位符解析）。

**关键目录：**
- `components/` - 共享片段：`rules.ts`、`capabilities.ts`、`editing_files.ts` 等
- `variants/` - 模型特定的：`generic/`、`next-gen/`、`xs/`、`gpt-5/`、`gemini-3/`、`hermes/`、`glm/` 等
- `templates/` - 模板引擎和占位符定义

**变体层级（询问用户要修改哪个）：**
- **Next-gen**（Claude 4、GPT-5、Gemini 2.5）：`next-gen/`、`native-next-gen/`、`native-gpt-5/`、`native-gpt-5-1/`、`gemini-3/`、`gpt-5/`
- **Standard**（默认回退）：`generic/`
- **本地/小模型**：`xs/`、`hermes/`、`glm/`

**覆盖机制的工作方式：** 变体可以通过 `config.ts` 中的 `componentOverrides` 覆盖组件，或在 `template.ts` 中提供自定义模板（例如 `next-gen/template.ts` 导出 `rules_template`）。如果没有覆盖，则使用 `components/` 中的共享组件。

**示例：向 RULES 部分添加规则**
1. 检查变体是否覆盖了 rules：在 `variants/*/template.ts` 中查找 `rules_template`，或在 `config.ts` 中查找 `componentOverrides.RULES`
2. 如果是共享的：修改 `components/rules.ts`
3. 如果被覆盖了：修改该变体的模板
4. XS 变体比较特殊——在 `template.ts` 中有大量压缩的内联内容

**任何变更后，重新生成快照：**
```bash
UPDATE_SNAPSHOTS=true npm run test:unit
```
快照位于 `__tests__/__snapshots__/`。测试会验证所有模型族和上下文变化（浏览器、MCP、焦点链）。

## 修改默认斜杠命令
需要更新三个地方：
- `src/core/slash-commands/index.ts` - 命令定义
- `src/core/prompts/commands.ts` - 系统提示词集成
- `webview-ui/src/utils/slash-commands.ts` - Webview 自动补全

## 添加新的全局状态键
向全局状态添加新键需要在多个地方更新。遗漏任何步骤都会导致静默失败。

所需步骤：
1. 在 `src/shared/storage/state-keys.ts` 中定义类型 - 添加到 `GlobalState` 或 `Settings` 接口
2. 在 `src/core/storage/utils/state-helpers.ts` 中从 globalState 读取：
   - 在 `readGlobalStateFromDisk()` 中添加 `const myKey = context.globalState.get<GlobalStateAndSettings["myKey"]>("myKey")`
   - 添加到返回对象中：`myKey: myKey ?? defaultValue,`
3. StateManager 在初始化后通过 `setGlobalState()`/`getGlobalStateKey()` 处理读写

常见错误：只添加了返回值而没有 `context.globalState.get()` 调用。这能编译通过，但值在加载时始终为 `undefined`。

设置管道陷阱：如果一个键可以从设置中由用户切换，需要连接两个 controller 更新路径：
- `src/core/controller/state/updateSettings.ts` 用于 webview 的 `updateSetting(...)`
- `src/core/controller/state/updateSettingsCli.ts` 用于 CLI/ACP 设置更新
遗漏任一路径会导致切换在某个界面看似已更改，但后端状态保持不变。

Webview 切换陷阱：设置变更还必须通过状态 payload 往返传递。
- 在 `proto/cline/state.proto` 的 `UpdateSettingsRequest` 中添加字段（用于 webview 更新请求），然后运行 `npm run protos`
- 在 `Controller.getStateToPostToWebview()`（`src/core/controller/index.ts`）中包含该键
- 确保 `ExtensionState` 和 webview 默认值包含该键（`src/shared/ExtensionMessage.ts`、`webview-ui/src/context/ExtensionStateContext.tsx`）
如果缺少此往返连线，后端值可以更新，但 webview 中的切换会显示卡住或回退。

## StateManager 缓存 vs 直接 globalState 访问
StateManager 使用在 `common.ts` 中 `StateManager.initialize(context)` 期间填充的内存缓存。对于大多数状态，使用 `controller.stateManager.setGlobalState()`/`getGlobalStateKey()`。

例外：在扩展启动时立即需要的状态（缓存就绪之前）

当窗口 A 设置状态并立即打开窗口 B 时，新窗口的 StateManager 缓存在初始化期间从 `context.globalState` 填充。如果你需要在窗口 B 启动时立即读取状态（例如在 `common.ts` 的 `initialize()` 中），直接从 `context.globalState.get()` 读取，而不是使用 StateManager 的缓存。

示例模式（参见 `lastShownAnnouncementId` 和 `worktreeAutoOpenPath`）：
```typescript
// 写入（常规模式）
controller.stateManager.setGlobalState("myKey", value)

// 在 common.ts 中启动时读取（绕过缓存）
const value = context.globalState.get<string>("myKey")
```

这仅在 StateManager 缓存完全可用之前的短暂启动窗口期间，用于跨窗口状态读取时才需要。初始化后的正常状态访问应使用 StateManager。

## ChatRow 取消/中断状态
当 ChatRow 显示加载/进行中状态（转圈）时，你必须处理任务被取消时的情况。这并不明显，因为取消操作不会更新消息内容——你必须从上下文中推断。

**模式如下：**
1. 消息有一个 `status` 字段（例如 `"generating"`、`"complete"`、`"error"`），以 JSON 形式存储在 `message.text` 中
2. 当操作中途被取消时，status 会永远停留在 `"generating"`——没有人会更新它
3. 要检测取消，检查两个条件：
   - `!isLast` — 如果此消息不再是最后一条消息，说明它之后发生了其他事情（被中断）
   - `lastModifiedMessage?.ask === "resume_task" || "resume_completed_task"` — 任务刚刚被取消，正在等待恢复

**来自 `generate_explanation` 的示例：**
```tsx
const wasCancelled =
    explanationInfo.status === "generating" &&
    (!isLast ||
        lastModifiedMessage?.ask === "resume_task" ||
        lastModifiedMessage?.ask === "resume_completed_task")
const isGenerating = explanationInfo.status === "generating" && !wasCancelled
```

**为什么需要两个检查？**
- `!isLast` 捕获的场景：取消 → 恢复 → 做了其他事 → 这条旧消息已过时
- `lastModifiedMessage?.ask === "resume_task"` 捕获的场景：刚刚取消，还未恢复，此消息在技术上仍然是"最后一条"

**另请参阅：** `BrowserSessionRow.tsx` 使用类似模式，通过 `isLastApiReqInterrupted` 和 `isLastMessageResume` 实现。

**后端侧：** 当流式传输被取消时，通过在流式函数返回后检查 `taskState.abort` 来正确清理（关闭标签页、清除注释等）。
