# 处理 PR 评论

审查并处理当前分支 PR 上的所有评论。

## 步骤

1. 获取当前分支名称并找到关联的 PR：
   ```bash
   gh pr view --json number,title,body
   ```

2. 理解 PR 上下文：
   - 获取完整差异：`git diff origin/main...HEAD`
   - 阅读变更的文件，理解 PR 的目的
   - 如需更广泛的上下文，阅读相关文件
   - 理解变更的意图和精神，而不仅仅是代码本身

3. 获取所有 PR 评论：
   - 行内评论：`gh api repos/{owner}/{repo}/pulls/{pr_number}/comments`
   - 通用评论：`gh pr view {pr_number} --json comments,reviews`

4. 展示所有评论的摘要，并为每条评论给出你的建议（采纳、跳过或回复）。忽略机器人噪音（发布自动化、CI 状态等）。

5. **等待我的批准**后再继续。

6. 获得批准后：
   - 应用代码变更并提交
   - 回复已处理或有意跳过的评论
   - 推送提交
