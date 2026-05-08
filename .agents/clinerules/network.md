# 网络与代理支持

为确保 Cline 在所有环境（VSCode、JetBrains、CLI）及各种网络配置（尤其是企业代理）下正常工作，所有网络活动都必须严格遵循以下准则。

在扩展代码中，**不要**使用全局 `fetch` 或默认的 `axios` 实例。（注意：`shared/net.ts` 不受此规则约束，因为它负责设置 fetch 封装器。）在 Webview 代码中，**应该**使用全局 `fetch`。

全局 `fetch` 和默认 `axios` 不会在所有环境中自动获取代理配置（特别是 JetBrains 和 CLI）。你**必须**使用 `@/shared/net` 中提供的工具函数，它们会处理代理 agent 配置。在 webview 中，浏览器/嵌入器会处理代理。

## 准则

### 1. 使用 `fetch`

不要使用 `fetch(...)`，而是导入支持代理的封装器：

```typescript
import { fetch } from '@/shared/net'

// 用法与全局 fetch 完全相同
const response = await fetch('https://api.example.com/data')
```

### 2. 使用 `axios`

使用 `axios` 时，必须应用 `getAxiosSettings()` 返回的设置：

```typescript
import axios from 'axios'
import { getAxiosSettings } from '@/shared/net'

const response = await axios.get('https://api.example.com/data', {
  headers: { 'Authorization': '...' },
  ...getAxiosSettings() // <--- 关键：在需要时注入代理 agent
})
```

### 3. 第三方客户端（OpenAI、Ollama 等）

大多数 API 客户端库允许你自定义 `fetch` 实现。你**必须**将支持代理的 `fetch` 传递给这些客户端。

**示例（OpenAI）：**
```typescript
import OpenAI from "openai"
import { fetch } from "@/shared/net"

this.client = new OpenAI({
  apiKey: '...',
  fetch, // <--- 关键：传入我们的 fetch 封装器
})
```

### 4. 测试

使用 `mockFetchForTesting` 来模拟底层 fetch 实现。

**示例（回调方式）：**

```
import { mockFetchForTesting } from "@/shared/net"

...
  let mockFetch = ...
  mockFetchForTesting(mockFetch, () => {
    // 这会调用 mockFetch
    fetch('https://foo.example').then(...)
  })
  // 回调返回后，原始 fetch 会立即恢复。
```

**示例（Promise 方式）：**

```
import { mockFetchForTesting } from "@/shared/net"

...
  let mockFetch = ...
  await mockFetchForTesting(mockFetch, async () => {
    await ...
    // 这会调用 mockFetch
    await fetch('https://foo.example')
    ...
  })
  // 当回调返回的 Promise settle 后，原始 fetch 会被恢复
```

## 验证

如果你正在添加新的网络调用或集成：
1. 检查是否已导入 `@/shared/net.ts`。
2. 确保使用了 `fetch` 或 `getAxiosSettings`。
3. 验证第三方客户端已配置为使用自定义 fetch。
