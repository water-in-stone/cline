# CLI 开发

CLI 位于 `cli/` 目录，使用 React Ink 构建终端 UI。

- 如需使用终端颜色，参见 `cli/src/constants/colors.ts` 中复用的终端颜色，例如 `COLORS.primaryBlue` 高亮色（选中项、加载动画、成功状态）。
- 不要将 `dimColor` 与 gray 一起使用（例如 `<Text color="gray" dimColor>`）——这样可读性太差。次要文本使用 `color="gray"`，主要文本使用默认前景色（不设颜色）。
- 在考虑如何处理来自 core 的状态或消息时，参考 webview 是如何与 VS Code 扩展通信的。
- 更新 webview 时，请考虑并建议用户同时更新 CLI TUI，因为我们希望为终端用户提供与 VS Code 扩展用户一致的体验。

## 添加新的 API Provider

向扩展添加新的 API provider 时，也必须更新 CLI：

1. **更新 `cli/src/components/ModelPicker.tsx`**：将 provider 添加到 `providerModels` 映射中，使 `getDefaultModelId()` 返回正确的默认模型。从 `@shared/api` 导入模型和默认 ID：
   ```typescript
   import { newProviderDefaultModelId, newProviderModels } from "@/shared/api"

   export const providerModels = {
     // ...已有的 providers
     "new-provider": { models: newProviderModels, defaultId: newProviderDefaultModelId },
   }
   ```

2. **使用 `applyProviderConfig()` 处理认证流程**：为 provider 实现 OAuth 或其他认证流程时，使用 `cli/src/utils/provider-config.ts` 中的共享工具函数：
   ```typescript
   import { applyProviderConfig } from "../utils/provider-config"

   // 认证成功后：
   await applyProviderConfig({ providerId: "new-provider", controller })
   ```
   该函数会处理设置 provider、默认模型、API key 映射、状态持久化以及重建 API handler。

3. **Provider 特定的认证**：如果 provider 使用 OAuth（如 `openai-codex`），需要在 `SettingsPanelContent.tsx` 的 `handleProviderSelect` 回调中添加处理逻辑。参考已有的 Codex OAuth 流程作为范例。