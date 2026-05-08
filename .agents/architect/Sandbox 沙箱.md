# Sandbox 沙箱

## 目录

- [第一层：命令权限控制 (Command Permission Controller)](#第一层命令权限控制-Command-Permission-Controller)
- [第二层：文件访问控制 (.clineignore)](#第二层文件访问控制-clineignore)
- [第三层：工具级批准机制 (Auto Approval)](#第三层工具级批准机制-Auto-Approval)
- [第四层：命令执行审批流程](#第四层命令执行审批流程)
- [第五层：检查点系统（Git 影子仓库）](#第五层检查点系统Git-影子仓库)
- [第六层：终端隔离](#第六层终端隔离)
- [总结](#总结)

**Cline 没有使用传统意义上的容器/Docker 沙箱**，而是采用了一套**多层纵深防御 (Defense in Depth)** 策略来保护 agent 的代码执行安全。

伪代码

```typescript title="Cline 沙箱设计简版实现"
/**
 * 没用 Docker/VM 物理隔离，而是采用多层逻辑安全层：
 *   命令权限（环境级）→ 文件访问控制 → 自动批准网关 → 人工审批 → 检查点回滚
 *
 * 核心理念：预防 + 审批 + 可逆
 */

// ============================================================================
// 第一层：命令权限控制 (对应 CommandPermissionController)
// 通过 allow/deny 模式匹配，在环境级别拦截危险命令
// ============================================================================

interface CommandPermissionConfig {
  allow?: string[] // 允许的命令通配符模式
  deny?: string[] // 拒绝的命令通配符模式
  allowRedirects?: boolean // 是否允许重定向操作符
}

interface PermissionResult {
  allowed: boolean
  reason: string
  matchedPattern?: string
}

class CommandPermissionController {
  private config: CommandPermissionConfig | null

  constructor(config?: CommandPermissionConfig) {
    this.config = config ?? null
  }

  validateCommand(command: string): PermissionResult {
    // 无配置 = 全部放行（向后兼容）
    if (!this.config) {
      return { allowed: true, reason: "no_config" }
    }

    // 1. 检测危险字符（换行符可注入新命令，反引号可命令替换）
    if (this.hasDangerousChars(command)) {
      return { allowed: false, reason: "dangerous_chars_detected" }
    }

    // 2. 检查重定向操作符
    if (!this.config.allowRedirects && /[>|<]/.test(command)) {
      return { allowed: false, reason: "redirect_not_allowed" }
    }

    // 3. 分段验证链式命令（&& || | ; 连接的每段都要验证）
    const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/)
    for (const segment of segments) {
      const result = this.validateSingleCommand(segment.trim())
      if (!result.allowed) {
        return { ...result, reason: `segment_denied: ${segment}` }
      }
    }

    return { allowed: true, reason: "all_segments_passed" }
  }

  private validateSingleCommand(cmd: string): PermissionResult {
    // deny 优先级高于 allow
    if (this.config?.deny) {
      for (const pattern of this.config.deny) {
        if (this.matchWildcard(cmd, pattern)) {
          return { allowed: false, reason: "denied", matchedPattern: pattern }
        }
      }
    }

    // 有 allow 规则时，未匹配 = 拒绝（默认拒绝）
    if (this.config?.allow?.length) {
      for (const pattern of this.config.allow) {
        if (this.matchWildcard(cmd, pattern)) {
          return { allowed: true, reason: "allowed", matchedPattern: pattern }
        }
      }
      return { allowed: false, reason: "no_allow_match" }
    }

    return { allowed: true, reason: "no_rules" }
  }

  /** 简化的通配符匹配：* 匹配任意字符序列 */
  private matchWildcard(text: string, pattern: string): boolean {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    )
    return regex.test(text)
  }

  /** 检测引号外的危险字符 */
  private hasDangerousChars(command: string): boolean {
    let inSingle = false,
      inDouble = false
    for (let i = 0; i < command.length; i++) {
      const ch = command[i]
      if (ch === "'" && !inDouble) inSingle = !inSingle
      if (ch === '"' && !inSingle) inDouble = !inDouble
      if (!inSingle && !inDouble) {
        // 换行符在引号外 = 命令注入
        if (/[\n\r]/.test(ch)) return true
        // 反引号在单引号外 = 命令替换（双引号内也危险）
        if (ch === "`" && !inSingle) return true
      }
    }
    return false
  }
}

// ============================================================================
// 第二层：文件访问控制 (对应 ClineIgnoreController)
// 基于 .gitignore 语法的文件级访问限制
// ============================================================================

class FileAccessController {
  private ignorePatterns: string[] = []
  private cwd: string

  constructor(cwd: string, clineignoreContent?: string) {
    this.cwd = cwd
    if (clineignoreContent) {
      this.ignorePatterns = clineignoreContent
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    }
  }

  /** 验证文件路径是否允许访问 */
  validateAccess(filePath: string): boolean {
    // .clineignore 文件本身永远不允许访问（防止被篡改）
    if (filePath.endsWith(".clineignore")) return false

    const relativePath = filePath.startsWith(this.cwd)
      ? filePath.slice(this.cwd.length + 1)
      : filePath

    for (const pattern of this.ignorePatterns) {
      if (this.matchIgnorePattern(relativePath, pattern)) {
        return false // 匹配到 = 被忽略 = 拒绝访问
      }
    }
    return true
  }

  /** 验证 shell 命令中是否尝试访问受限文件 */
  validateCommand(command: string): string | undefined {
    if (this.ignorePatterns.length === 0) return undefined

    const fileReadCmds = ["cat", "less", "head", "tail", "grep", "awk", "sed"]
    const parts = command.trim().split(/\s+/)
    const baseCmd = parts[0]

    if (fileReadCmds.includes(baseCmd)) {
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].startsWith("-")) continue // 跳过参数标志
        if (!this.validateAccess(parts[i])) {
          return parts[i] // 返回被拒绝的文件路径
        }
      }
    }
    return undefined
  }

  private matchIgnorePattern(path: string, pattern: string): boolean {
    // 简化实现：支持 * 通配符和目录匹配
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "(/.*)?$",
    )
    return regex.test(path)
  }
}

// ============================================================================
// 第三层：自动批准网关 (对应 AutoApprove)
// 三级权限体系 + 细粒度工具控制
// ============================================================================

interface AutoApprovalSettings {
  yoloMode: boolean // 全自动，无需确认（最危险）
  autoApproveAll: boolean // 自动批准所有工具
  actions: {
    readFiles: boolean // 读取工作区内文件
    readFilesExternally: boolean // 读取工作区外文件
    editFiles: boolean // 编辑工作区内文件
    editFilesExternally: boolean // 编辑工作区外文件
    executeSafeCommands: boolean // 执行模型标记为安全的命令
    executeAllCommands: boolean // 执行所有命令（含危险命令）
    useBrowser: boolean // 浏览器工具
    useMcp: boolean // MCP 服务器
  }
}

type ToolName = "read_file" | "write_file" | "execute_command" | "browser" | "mcp"

class AutoApproveGateway {
  constructor(private settings: AutoApprovalSettings) {}

  /**
   * 判断工具是否应自动批准
   * 返回 [safeApproved, allApproved] 元组
   * - safeApproved: 模型标记为安全时自动批准
   * - allApproved: 即使模型标记为危险也自动批准
   */
  shouldAutoApprove(toolName: ToolName): [boolean, boolean] {
    // YOLO 模式：全部自动批准
    if (this.settings.yoloMode) return [true, true]
    // 全部批准模式
    if (this.settings.autoApproveAll) return [true, true]

    // 细粒度控制
    const a = this.settings.actions
    switch (toolName) {
      case "read_file":
        return [a.readFiles, a.readFilesExternally]
      case "write_file":
        return [a.editFiles, a.editFilesExternally]
      case "execute_command":
        return [a.executeSafeCommands, a.executeAllCommands]
      case "browser":
        return [a.useBrowser, a.useBrowser]
      case "mcp":
        return [a.useMcp, a.useMcp]
      default:
        return [false, false]
    }
  }
}

// ============================================================================
// 第四层：检查点系统 (对应 CheckpointTracker)
// 影子 Git 仓库提供完全回滚能力 —— 即使操作被批准执行了也可撤销
// ============================================================================

interface Checkpoint {
  hash: string
  timestamp: number
  description: string
  snapshot: Map<string, string> // 文件路径 -> 内容快照
}

class CheckpointTracker {
  private checkpoints: Checkpoint[] = []
  private workspace: Map<string, string> // 模拟工作区文件系统

  constructor(workspace: Map<string, string>) {
    this.workspace = workspace
    // 创建初始检查点
    this.commit("Initial state")
  }

  /** 创建检查点（对应 shadow git commit） */
  commit(description: string = "Auto checkpoint"): string {
    const hash = Math.random().toString(36).slice(2, 10)
    const snapshot = new Map(this.workspace) // 深拷贝当前状态
    this.checkpoints.push({
      hash,
      timestamp: Date.now(),
      description,
      snapshot,
    })
    console.log(`  📸 Checkpoint created: ${hash} - "${description}"`)
    return hash
  }

  /** 恢复到指定检查点（对应 git reset --hard） */
  restore(hash: string): boolean {
    const checkpoint = this.checkpoints.find((c) => c.hash === hash)
    if (!checkpoint) {
      console.log(`  ❌ Checkpoint ${hash} not found`)
      return false
    }

    // 恢复文件状态
    this.workspace.clear()
    for (const [path, content] of checkpoint.snapshot) {
      this.workspace.set(path, content)
    }

    // 丢弃该检查点之后的所有检查点
    const idx = this.checkpoints.indexOf(checkpoint)
    this.checkpoints = this.checkpoints.slice(0, idx + 1)

    console.log(`  ⏪ Restored to checkpoint: ${hash} - "${checkpoint.description}"`)
    return true
  }

  /** 获取两个检查点之间的差异 */
  diff(fromHash: string, toHash: string): string[] {
    const from = this.checkpoints.find((c) => c.hash === fromHash)
    const to = this.checkpoints.find((c) => c.hash === toHash)
    if (!from || !to) return []

    const changes: string[] = []
    // 检查新增和修改
    for (const [path, content] of to.snapshot) {
      if (!from.snapshot.has(path)) changes.push(`+ ${path}`)
      else if (from.snapshot.get(path) !== content) changes.push(`~ ${path}`)
    }
    // 检查删除
    for (const path of from.snapshot.keys()) {
      if (!to.snapshot.has(path)) changes.push(`- ${path}`)
    }
    return changes
  }

  listCheckpoints(): Checkpoint[] {
    return [...this.checkpoints]
  }
}

// ============================================================================
// 沙箱编排器：串联所有安全层
// 对应 Cline 的 ExecuteCommandToolHandler + Task 执行流程
// ============================================================================

interface ToolRequest {
  toolName: ToolName
  command?: string // execute_command 时的命令
  filePath?: string // read_file / write_file 时的路径
  fileContent?: string // write_file 时的内容
  requiresApproval: boolean // 模型标记：该操作是否危险
}

class ClineSandbox {
  private permissionCtrl: CommandPermissionController
  private fileAccessCtrl: FileAccessController
  private approveGateway: AutoApproveGateway
  private checkpointTracker: CheckpointTracker
  private workspace: Map<string, string>

  constructor(
    permConfig: CommandPermissionConfig | undefined,
    clineignore: string | undefined,
    approvalSettings: AutoApprovalSettings,
    initialFiles: Record<string, string>,
  ) {
    this.workspace = new Map(Object.entries(initialFiles))
    this.permissionCtrl = new CommandPermissionController(permConfig)
    this.fileAccessCtrl = new FileAccessController("/workspace", clineignore)
    this.approveGateway = new AutoApproveGateway(approvalSettings)
    this.checkpointTracker = new CheckpointTracker(this.workspace)
  }

  /**
   * 核心执行流程 —— 每个工具调用都经过完整的安全链
   *
   *  ┌─────────────────────────────────────────────────┐
   *  │  1. 命令权限验证 (CLINE_COMMAND_PERMISSIONS)    │
   *  │  2. 文件访问验证 (.clineignore)                 │
   *  │  3. 自动批准检查 (AutoApprove)                  │
   *  │  4. 人工审批 (如果未自动批准)                    │
   *  │  5. 执行操作                                    │
   *  │  6. 创建检查点 (shadow git commit)              │
   *  └─────────────────────────────────────────────────┘
   */
  async executeTool(request: ToolRequest): Promise<string> {
    console.log(`\n🔧 Tool: ${request.toolName}${request.command ? ` → "${request.command}"` : ""}${request.filePath ? ` → ${request.filePath}` : ""}`)

    // ---- 第一层：命令权限验证 ----
    if (request.toolName === "execute_command" && request.command) {
      const permResult = this.permissionCtrl.validateCommand(request.command)
      if (!permResult.allowed) {
        return this.reject(`🚫 [命令权限] 拒绝: ${permResult.reason}`)
      }
      console.log("  ✅ [命令权限] 通过")
    }

    // ---- 第二层：文件访问验证 ----
    if (request.toolName === "execute_command" && request.command) {
      const blockedFile = this.fileAccessCtrl.validateCommand(request.command)
      if (blockedFile) {
        return this.reject(`🚫 [文件访问] 命令尝试访问受限文件: ${blockedFile}`)
      }
    }
    if (request.filePath && !this.fileAccessCtrl.validateAccess(request.filePath)) {
      return this.reject(`🚫 [文件访问] 路径被 .clineignore 阻止: ${request.filePath}`)
    }
    if (request.filePath || request.command) {
      console.log("  ✅ [文件访问] 通过")
    }

    // ---- 第三层：自动批准检查 ----
    const [autoApproveSafe, autoApproveAll] = this.approveGateway.shouldAutoApprove(request.toolName)

    let approved = false
    if (!request.requiresApproval && autoApproveSafe) {
      // 模型标记为安全 + 安全自动批准已开启
      approved = true
      console.log("  ✅ [自动批准] 安全命令，自动通过")
    } else if (request.requiresApproval && autoApproveSafe && autoApproveAll) {
      // 模型标记为危险，但两项批准都开启
      approved = true
      console.log("  ✅ [自动批准] 全部批准已开启，自动通过")
    }

    // ---- 第四层：人工审批 ----
    if (!approved) {
      const userDecision = await this.askUserApproval(request)
      if (!userDecision) {
        return this.reject("🚫 [人工审批] 用户拒绝了该操作")
      }
      console.log("  ✅ [人工审批] 用户批准")
    }

    // ---- 第五层：执行操作 ----
    const result = this.performAction(request)
    console.log(`  ⚡ [执行] ${result}`)

    // ---- 第六层：创建检查点 ----
    this.checkpointTracker.commit(
      `After ${request.toolName}: ${request.command || request.filePath || ""}`,
    )

    return result
  }

  /** 模拟人工审批对话框 */
  private async askUserApproval(request: ToolRequest): Promise<boolean> {
    console.log(`  ⏳ [人工审批] 等待用户确认: "${request.command || request.filePath}"`)
    // 实际 Cline 中会弹出 VSCode 通知，这里模拟自动批准
    return true
  }

  /** 执行实际操作 */
  private performAction(request: ToolRequest): string {
    switch (request.toolName) {
      case "execute_command":
        return `命令已执行: ${request.command}`
      case "read_file":
        const content = this.workspace.get(request.filePath!)
        return content ? `读取成功: ${content.slice(0, 50)}...` : "文件不存在"
      case "write_file":
        this.workspace.set(request.filePath!, request.fileContent || "")
        return `文件已写入: ${request.filePath}`
      default:
        return `${request.toolName} 已执行`
    }
  }

  private reject(message: string): string {
    console.log(`  ${message}`)
    return message
  }

  /** 回滚到检查点 */
  restoreCheckpoint(hash: string): boolean {
    return this.checkpointTracker.restore(hash)
  }

  getCheckpoints() {
    return this.checkpointTracker.listCheckpoints()
  }

  getWorkspaceFiles(): Map<string, string> {
    return this.workspace
  }
}

// ============================================================================
// 演示：模拟完整的安全流程
// ============================================================================

async function demo() {
  console.log("=" .repeat(70))
  console.log("  Cline 沙箱设计演示")
  console.log("=".repeat(70))

  const sandbox = new ClineSandbox(
    // 第一层配置：命令权限
    {
      allow: ["npm *", "node *", "git status", "ls *", "cat *"],
      deny: ["rm -rf *", "curl *", "wget *"],
      allowRedirects: false,
    },
    // 第二层配置：.clineignore 内容
    `.env\nsecrets/*\n*.key`,
    // 第三层配置：自动批准设置
    {
      yoloMode: false,
      autoApproveAll: false,
      actions: {
        readFiles: true,
        readFilesExternally: false,
        editFiles: true,
        editFilesExternally: false,
        executeSafeCommands: true, // 模型标记为安全的命令自动批准
        executeAllCommands: false, // 危险命令需人工确认
        useBrowser: false,
        useMcp: false,
      },
    },
    // 初始工作区文件
    {
      "src/index.ts": 'console.log("hello")',
      "src/utils.ts": "export function add(a: number, b: number) { return a + b }",
      ".env": "API_KEY=sk-secret-123",
      "package.json": '{"name": "demo"}',
    },
  )

  // --- 场景 1：安全命令，自动通过 ---
  console.log("\n" + "─".repeat(70))
  console.log("场景 1: 安全命令 → 自动批准通过")
  await sandbox.executeTool({
    toolName: "execute_command",
    command: "npm install lodash",
    requiresApproval: false, // 模型标记为安全
  })

  // --- 场景 2：危险命令被权限层拦截 ---
  console.log("\n" + "─".repeat(70))
  console.log("场景 2: 危险命令 → 命令权限层拦截")
  await sandbox.executeTool({
    toolName: "execute_command",
    command: "rm -rf /",
    requiresApproval: true,
  })

  // --- 场景 3：命令注入攻击被拦截 ---
  console.log("\n" + "─".repeat(70))
  console.log("场景 3: 命令注入攻击 → 危险字符检测拦截")
  await sandbox.executeTool({
    toolName: "execute_command",
    command: "echo hello\nrm -rf /",  // 换行符注入
    requiresApproval: false,
  })

  // --- 场景 4：尝试读取 .clineignore 保护的文件 ---
  console.log("\n" + "─".repeat(70))
  console.log("场景 4: 读取受保护文件 → .clineignore 拦截")
  await sandbox.executeTool({
    toolName: "read_file",
    filePath: ".env",
    requiresApproval: false,
  })

  // --- 场景 5：通过命令间接访问受限文件 ---
  console.log("\n" + "─".repeat(70))
  console.log("场景 5: 命令间接访问受限文件 → .clineignore 命令检查拦截")
  await sandbox.executeTool({
    toolName: "execute_command",
    command: "cat secrets/api.key",
    requiresApproval: false,
  })

  // --- 场景 6：重定向被拦截（数据外泄防护） ---
  console.log("\n" + "─".repeat(70))
  console.log("场景 6: 重定向操作 → 命令权限层拦截")
  await sandbox.executeTool({
    toolName: "execute_command",
    command: "cat /etc/passwd > /tmp/stolen.txt",
    requiresApproval: false,
  })

  // --- 场景 7：正常写入文件 + 检查点 ---
  console.log("\n" + "─".repeat(70))
  console.log("场景 7: 正常写入文件 → 全流程通过 + 创建检查点")
  const beforeWriteCheckpoints = sandbox.getCheckpoints()
  const lastCheckpointHash = beforeWriteCheckpoints[beforeWriteCheckpoints.length - 1].hash

  await sandbox.executeTool({
    toolName: "write_file",
    filePath: "src/index.ts",
    fileContent: 'import { add } from "./utils"\nconsole.log(add(1, 2))',
    requiresApproval: false,
  })

  // --- 场景 8：检查点回滚 ---
  console.log("\n" + "─".repeat(70))
  console.log("场景 8: 检查点回滚 → 撤销文件修改")
  console.log(`  📄 回滚前 src/index.ts: "${sandbox.getWorkspaceFiles().get("src/index.ts")}"`)
  sandbox.restoreCheckpoint(lastCheckpointHash)
  console.log(`  📄 回滚后 src/index.ts: "${sandbox.getWorkspaceFiles().get("src/index.ts")}"`)

  // --- 场景 9：危险命令需要人工审批 ---
  console.log("\n" + "─".repeat(70))
  console.log("场景 9: 危险命令 → 需人工审批（模型标记 requiresApproval=true）")
  await sandbox.executeTool({
    toolName: "execute_command",
    command: "npm publish",
    requiresApproval: true, // 模型认为这个命令有风险
  })

  console.log("\n" + "=".repeat(70))
  console.log("  演示结束")
  console.log("=".repeat(70))
  console.log("\n📊 所有检查点:")
  for (const cp of sandbox.getCheckpoints()) {
    console.log(`  ${cp.hash} | ${new Date(cp.timestamp).toISOString()} | ${cp.description}`)
  }
}

demo().catch(console.error)

```


整体设计分为以下五层：

***

### 第一层：命令权限控制 (Command Permission Controller)

**文件**: [\[CommandPermissionController.ts\]](\(src/core/permissions/CommandPermissionController.ts\) "\[CommandPermissionController.ts]")

通过环境变量 `CLINE_COMMAND_PERMISSIONS` 配置 JSON 格式的 allow/deny 列表：

- **deny 优先**：deny 规则优先于 allow 规则
- **通配符匹配**：`*` 匹配任意字符序列，`?` 匹配单个字符
- **链式命令分段验证**：对 `&&`、`||`、`|`、`;` 连接的每个命令段都独立验证
- **危险字符检测**：检测引号外的换行符、反引号（命令替换）等注入攻击手段
- **默认禁止重定向操作符**（`>`, `>>`, `<`），除非明确配置 `allowRedirects: true`

***

### 第二层：文件访问控制 (.clineignore)

**文件**: [\[ClineIgnoreController.ts\]](\(/src/core/ignore/ClineIgnoreController.ts\) "\[ClineIgnoreController.ts]")

基于 `.gitignore` 语法实现文件级访问控制：

- 使用 `ignore` 库进行模式匹配
- 用 `chokidar` 监听文件变化，实时热更新
- 不仅验证文件读写，还验证 shell 命令中可能的文件访问（如 `cat`、`grep`、`head` 等命令的参数）
- **始终阻止 ****`.clineignore`**** 文件本身**被访问/篡改

***

### 第三层：工具级批准机制 (Auto Approval)

**文件**: [\[autoApprove.ts\]](\(/src/core/task/tools/autoApprove.ts\) "\[autoApprove.ts]")

三级批准体系：

| 级别           | 说明            |
| ------------ | ------------- |
| **YOLO 模式**​ | 自动批准所有操作，无需确认 |
| **全部批准模式**​  | 完全自动批准所有工具    |
| **细粒度设置**​   | 针对不同操作类型独立开关  |

细粒度设置包括：

- `readFiles` / `readFilesExternally`（工作区内/外文件读取）
- `executeSafeCommands`（模型标记为安全的命令）

***

### 第四层：命令执行审批流程

**文件**: [\[ExecuteCommandToolHandler.ts\]](\(src/core/task/tools/handlers/ExecuteCommandToolHandler.ts\) "\[ExecuteCommandToolHandler.ts]")

执行链路为：

1. 模型发起命令请求，并标注 `requires_approval`（安全/危险）
2. `CommandPermissionController.validateCommand()` → 环境级拦截
3. `ClineIgnoreController.validateCommand()` → 文件访问拦截
4. `AutoApprove.shouldAutoApproveTool()` → 判断是否需要人工确认
5. 如不满足自动批准条件 → 弹出确认对话框，等待用户手动批准

***

### 第五层：检查点系统（Git 影子仓库）

> 🍭这个其实学习了 WebStorm，自带 Git 历史记录

**文件**: [\[CheckpointTracker.ts\]](\(src/integrations/checkpoints/CheckpointTracker.ts\) "\[CheckpointTracker.ts]")、[\[index.ts\]](\(src/integrations/checkpoints/index.ts\) "\[index.ts]")

这是 Cline 的"撤销网"——即使操作被批准执行了，也可以完全回滚：

- 为每个工作区创建**独立的影子 Git 仓库**（`.cline/checkpoints/.git`），不影响用户主 Git 历史
- 每次工具执行后自动创建检查点（commit）
- 支持 `git reset --hard` 恢复到任意检查点

***

### 第六层：终端隔离

**文件**: [\[VscodeTerminalManager.ts\]](\(src/hosts/vscode/terminal/VscodeTerminalManager.ts\) "\[VscodeTerminalManager.ts]")

- 利用 VS Code Shell Integration API 获取命令输出
- 每个命令在独立终端实例中执行
- 支持超时控制（默认 30 秒，长运行命令 300 秒）
- 输出实时流式返回，支持中断或后台继续

**VscodeTerminalManager 是"安全审批通过后的执行引擎"**，负责将命令安全地送入 VS Code 终端、捕获输出、并将结果反馈给 LLM，同时确保执行过程对用户完全可见和可控。

***

## 总结

Cline 的"沙箱"不是物理隔离（无 Docker/VM），而是一套**逻辑安全层**：

```markdown 
命令权限（环境级）→ 文件访问控制 → 自动批准网关 → 人工审批 → 检查点回滚
```


核心设计理念是：**预防 + 审批 + 可逆**。通过多层过滤预防危险操作，通过人工审批兜底，再通过检查点系统确保即使出错也能完全回滚。这种设计适合 VS Code 扩展场景——直接在用户本机环境执行，无法真正隔离，因此靠权限控制和回滚能力来保障安全。
