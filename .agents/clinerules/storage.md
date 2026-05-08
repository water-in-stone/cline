# 存储架构

全局设置、密钥和工作区状态存储在 `~/.cline/data/` 下的**基于文件的 JSON 存储**中。这是 VSCode、CLI 和 JetBrains 共享的存储层。

## 关键抽象

### `StorageContext` (src/shared/storage/storage-context.ts)
入口点。通过 `createStorageContext()` 创建并传递给 `StateManager.initialize()`。包含三个 `ClineFileStorage` 实例：
- `globalState` → `~/.cline/data/globalState.json`
- `secrets` → `~/.cline/data/secrets.json`（文件权限 0o600）
- `workspaceState` → `~/.cline/data/workspaces/<hash>/workspaceState.json`

### `ClineFileStorage` (src/shared/storage/ClineFileStorage.ts)
基于单个文件的同步 JSON 键值存储。支持 `get()`、`set()`、`setBatch()`、`delete()`。写入是原子性的（先写临时文件再重命名）。

### `StateManager` (src/core/storage/StateManager.ts)
基于 `StorageContext` 之上的内存缓存。所有运行时读取命中缓存；写入立即更新缓存并通过防抖机制刷新到磁盘。

## ⚠️ 不要使用 VSCode 的 ExtensionContext 进行存储

**不要**从 `context.globalState`、`context.workspaceState` 或 `context.secrets` 读取或写入持久化数据。这些是 VSCode 特有的，在 CLI 或 JetBrains 中不可用。

应使用以下方式：
```typescript
// 读取状态
StateManager.get().getGlobalStateKey("myKey")
StateManager.get().getSecretKey("mySecretKey")
StateManager.get().getWorkspaceStateKey("myWsKey")

// 写入状态
StateManager.get().setGlobalState("myKey", value)
StateManager.get().setSecret("mySecretKey", value)
StateManager.get().setWorkspaceState("myWsKey", value)
```

请注意，你的数据可能会被与写入时不同的客户端读取。例如，在 JetBrains 中由 Cline 写入的值可能会被 Cline CLI 读取。

## VSCode 迁移 (src/hosts/vscode/vscode-to-file-migration.ts)

在 VSCode 启动时，迁移程序会将数据从 VSCode 的 `ExtensionContext` 存储复制到基于文件的存储中。此过程在 `src/common.ts` 中 `StateManager.initialize()` 之前运行。

- **哨兵值**：全局状态和工作区状态中的 `__vscodeMigrationVersion` 键——防止重复迁移。
- **合并策略**：文件存储优先。已有的值永远不会被覆盖。
- **安全降级**：VSCode 存储不会被清除，因此旧版本的扩展仍然可以正常工作。

## 添加新的存储键

1. 添加到 `src/shared/storage/state-keys.ts`（参见已有的模式）
2. 通过 `StateManager` 读写（**不要**通过 `context.globalState`）
3. 如果添加的是密钥，需要添加到 `state-keys.ts` 中的 `SecretKeys` 数组

## 文件布局

```
~/.cline/
  data/
    globalState.json          # 全局设置与状态
    secrets.json              # API 密钥（文件权限 0o600）
    tasks/
      taskHistory.json        # 任务历史（独立文件）
    workspaces/
      <hash>/
        workspaceState.json   # 每个工作区的开关配置
```
