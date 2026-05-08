# Git 差异分析工作流

## 目标
分析当前分支相对于 main 分支的变更，为开发决策提供有据可依的洞察和上下文。

## 步骤 1：收集 Git 信息
<important>除了运行这些命令所必需的内容外，不要返回任何文本或对话</important>

**运行以下命令获取最新变更（bash）：**
```bash
B=$(for c in main master origin/main origin/master; do git rev-parse --verify -q "$c" >/dev/null && echo "$c" && break; done); B=${B:-HEAD}; r(){ git branch --show-current; printf "=== STATUS ===\n"; git status --porcelain | cat; printf "=== COMMIT MESSAGES ===\n"; git log "$B"..HEAD --oneline | cat; printf "=== CHANGED FILES ===\n"; git diff "$B" --name-only | cat; printf "=== FULL DIFF ===\n"; git diff "$B" | cat; }; L=$(r | wc -l); if [ "$L" -gt 500 ]; then r > cline-git-analysis.temp && echo "::OUTPUT_FILE=cline-git-analysis.temp"; else r; fi
```

```powershell
$B=$null;foreach($c in 'main','master','origin/main','origin/master'){git rev-parse --verify -q $c *> $null;if($LASTEXITCODE -eq 0){$B=$c;break}};if(-not $B){$B='HEAD'};function r([string]$b){git rev-parse --abbrev-ref HEAD; '=== STATUS ==='; git status --porcelain | cat; '=== COMMIT MESSAGES ==='; git log "$b"..HEAD --oneline | cat; '=== CHANGED FILES ==='; git diff "$b" --name-only | cat; '=== FULL DIFF ==='; git diff "$b" | cat};$out=r $B|Out-String;$lines=($out -split "`r?`n").Count;if($lines -gt 500){$out|Set-Content -NoNewline cline-git-analysis.temp; '::OUTPUT_FILE=cline-git-analysis.temp'}else{$out}
```

## 步骤 2：静默、结构化分析阶段
- 分析所有 git 输出，不提供评论或叙述
- 阅读完整差异以理解变更的范围和性质
- 识别模式、架构修改或潜在影响
- 使用 `read_file` 检查任何与你观察到的变更相关的文件

## 步骤 3：上下文收集
- 分析相关代码，不提供评论或叙述
- 如需完整理解，阅读相关的源文件
- 检查跨越变更的依赖项、导入或交叉引用
- 理解围绕修改的更广泛代码库上下文
- 此额外上下文收集应包括相关的后端代码以及相关的 UI/前端代码
- 通常你需要分析至少几个文件（可能更多）才能完成此步骤
- 如果已消耗超过 60% 的可用上下文窗口，则不应继续阅读额外的上下文
- 如果消耗不到 40% 的上下文窗口，则应继续审查额外的上下文

## 步骤 4：准备与用户交互
**仅在完成全部分析后：**
- 基于全面理解与用户互动
- 提供关于特定修改及其影响的洞察
- 如果你确定存在，指出潜在的破坏性变更或兼容性问题
- 基于完整的变更集和上下文收集，以知情的上下文回答问题
- 如果用户未提供问题，或问题不足以提供高质量回复，请提出简短（一句话）的澄清问题
- 仅在建议适用于用户请求且与你观察到的变更相关时才提供建议

## 关键规则
- **git 研究阶段不输出散文或对话**
- **上下文收集阶段不输出散文或对话**
- **在任何用户交互之前完成所有分析**
- **将收集到的信息用于所有后续问题和洞察**
- **专注于在讨论之前理解完整的全貌**

## 可选：额外分析命令
需要更深入调查时使用：

```shell
# 带作者信息的详细提交历史
git log main..HEAD --format="%h %s (%an)" | cat

# 变更统计
git diff main --stat | cat

# 特定文件类型的变更
git diff main --name-only | grep -E '\.(ts|js|tsx|jsx|py|md)$' | cat
