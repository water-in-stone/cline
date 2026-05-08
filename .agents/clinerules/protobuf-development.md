# Cline Protobuf 开发指南

本指南介绍如何为 webview（前端）和 extension host（后端）之间的通信添加新的 gRPC 端点。

## 概述

Cline 使用 [Protobuf](https://protobuf.dev/) 定义强类型 API，确保高效且类型安全的通信。所有定义位于 `/proto` 目录中。编译器和插件已作为项目依赖包含，无需手动安装。

## 核心概念与最佳实践

-   **文件结构**：每个功能领域应有自己的 `.proto` 文件（例如 `account.proto`、`task.proto`）。
-   **消息设计**：
    -   对于简单的单值数据，使用 `proto/common.proto` 中的共享类型（例如 `StringRequest`、`Empty`、`Int64Request`）。这有助于保持一致性。
    -   对于复杂数据结构，在功能对应的 `.proto` 文件中定义自定义消息（参见 `task.proto` 中的 `NewTaskRequest` 等示例）。
-   **命名规范**：
    -   Services：`PascalCaseService`（例如 `AccountService`）。
    -   RPCs：`camelCase`（例如 `accountEmailIdentified`）。
    -   Messages：`PascalCase`（例如 `StringRequest`）。
-   **流式传输**：对于服务端到客户端的流式响应，在返回类型上使用 `stream` 关键字。参见 `account.proto` 中的 `subscribeToAuthCallback` 示例。

---

## 四步开发流程

以下以 `scrollToSettings` 为例，演示如何添加新的 RPC。

### 1. 在 `.proto` 文件中定义 RPC

在 `proto/` 目录下的相应文件中添加你的服务方法。

**文件：`proto/ui.proto`**
```proto
service UiService {
  // ... 其他 RPCs
  // 在设置视图中滚动到指定的设置区域
  rpc scrollToSettings(StringRequest) returns (KeyValuePair);
}
```
这里我们使用了通用类型 `StringRequest` 和 `KeyValuePair`。

### 2. 编译定义

编辑 `.proto` 文件后，重新生成 TypeScript 代码。在项目根目录运行：
```bash
npm run protos
```
此命令会编译所有 `.proto` 文件，并将生成的代码输出到 `src/generated/` 和 `src/shared/`。不要手动编辑这些生成的文件。

### 3. 实现后端处理器

在后端创建 RPC 实现。处理器位于 `src/core/controller/[service-name]/`。

**文件：`src/core/controller/ui/scrollToSettings.ts`**
```typescript
import { Controller } from ".."
import { StringRequest, KeyValuePair } from "../../../shared/proto/common"

/**
 * 执行滚动到设置的操作
 * @param controller Controller 实例
 * @param request 包含要滚动到的设置区域 ID 的请求
 * @returns 带有 action 和 value 字段的 KeyValuePair，供 UI 处理
 */
export async function scrollToSettings(controller: Controller, request: StringRequest): Promise<KeyValuePair> {
	return KeyValuePair.create({
		key: "scrollToSettings",
		value: request.value || "",
	})
}
```

### 4. 从 Webview 调用 RPC

在 `webview-ui/` 的 React 组件中调用新的 RPC。生成的客户端使这变得非常简单。

**文件：`webview-ui/src/components/browser/BrowserSettingsMenu.tsx`**（示例）
```tsx
import { UiServiceClient } from "../../../services/grpc"
import { StringRequest } from "../../../../shared/proto/common"

// ... 在 React 组件内部
const handleMenuClick = async () => {
    try {
        await UiServiceClient.scrollToSettings(StringRequest.create({ value: "browser" }))
    } catch (error) {
        console.error("滚动到浏览器设置时出错:", error)
    }
}
```
