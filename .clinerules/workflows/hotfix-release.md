# 热修复发布

通过从 main 分支上挑选特定提交到最新发布标签来创建热修复发布。

## 概述

此工作流帮助你：
1. 从 main 分支选择要包含在热修复中的特定提交
2. 在 main 分支上创建发布说明提交（变更日志 + 版本升级）
3. 将所有内容挑选到最新的发布标签上
4. 打标签并推送新发布

## 步骤 1：设置并收集信息

首先，确保我们在 main 分支上且是最新的：

```bash
git checkout main && git pull origin main
```

获取最新的发布标签：

```bash
git tag --sort=-v:refname | head -1
```

## 步骤 2：展示自上次发布以来的提交

显示自上次发布标签以来 main 分支上的所有提交：

```bash
LAST_TAG=$(git tag --sort=-v:refname | head -1)
git log ${LAST_TAG}..HEAD --oneline --format="%h %s (%an)"
```

同时获取标签上已有的提交消息（用于识别之前已挑选过的提交）。注意：分开运行这些命令以避免作者名中括号导致的 shell 解析问题：

```bash
LAST_TAG=$(git tag --sort=-v:refname | head -1)
PREV_TAG=$(git tag --sort=-v:refname | head -2 | tail -1)
```

```bash
git log $PREV_TAG..$LAST_TAG --oneline --format="%s"
```

**以编号格式向用户展示列表**，包含提交哈希、主题和作者。对于主题行已出现在标签历史中的提交（之前热修复中已挑选过的）或 "Release Notes" 提交，在其后添加 `(已在之前的热修复中)` 或 `(发布说明 - 跳过)` 以提示用户跳过这些。

询问用户要将哪些提交包含在热修复中。

使用 ask_followup_question 工具让用户指定想要的提交（通过编号或哈希）。

## 步骤 3：分析选定的提交

对每个选定的提交：
1. 获取完整提交消息：`git show --no-patch --format="%B" <hash>`
2. 获取差异以理解变更：`git show <hash> --stat`
3. 查找关联的 PR（如果有）：`gh pr list --search "<hash>" --state merged --json number,title --jq '.[0]'`

构建对这些变更的理解，为变更日志做准备。

## 步骤 4：确定新版本号

从 package.json 和最新标签解析当前版本：

```bash
LAST_TAG=$(git tag --sort=-v:refname | head -1)
echo "Last release: $LAST_TAG"
cat package.json | grep '"version"'
```

热修复始终递增补丁版本号（例如 3.40.0 -> 3.40.1，或 3.40.1 -> 3.40.2）。

**请用户确认新版本号。**

## 步骤 5：在 Main 分支上创建发布说明提交

在 main 分支上创建一个更新以下内容的提交：

1. **CHANGELOG.md** - 在顶部为热修复版本添加新章节：
   ```markdown
   ## [3.40.1]

   - 修复 1 的描述
   - 修复 2 的描述
   ```

   根据你对提交的分析，编写清晰、面向用户的描述。

2. **package.json** - 将 version 字段更新为新版本

3. 不需要清理 changelog-entry 文件。此仓库的贡献者不创建 changelog-entry 文件。

**跳过运行 `npm run install:all`** - 发布自动化会按需处理 lockfile 一致性。

提交消息格式：`v{VERSION} Release Notes (hotfix)`

在提交正文中说明：
- 这是一个热修复发布
- 列出将要包含的挑选提交

```bash
git add CHANGELOG.md package.json
git commit -m "v3.40.1 Release Notes (hotfix)

Hotfix release including:
- <commit1-hash>: <description>
- <commit2-hash>: <description>
"
```

推送到 main：

```bash
git push origin main
```

## 步骤 6：在标签上构建热修复

检出最新的发布标签（分离 HEAD 状态）：

```bash
LAST_TAG=$(git tag --sort=-v:refname | head -1)
git checkout $LAST_TAG
```

按顺序挑选选定的提交：

```bash
git cherry-pick <commit1-hash>
git cherry-pick <commit2-hash>
# ... 等等
```

最后，挑选你刚推送到 main 的发布说明提交：

```bash
# 获取发布说明提交的哈希（应该是 main 的 HEAD）
RELEASE_NOTES_COMMIT=$(git rev-parse main)
git cherry-pick $RELEASE_NOTES_COMMIT
```

## 步骤 7：打标签并推送

在所有挑选成功应用后：

```bash
# 为新发布打标签
git tag v{VERSION}

# 将标签推送到远程
git push origin v{VERSION}
```

## 步骤 8：返回 Main 并总结

返回 main 分支：

```bash
git checkout main
```

**将 Slack 公告消息复制到剪贴板**，包含版本号和每个修复的 PR 链接：

```
VS Code Hotfix v{VERSION} Published

- 修复 1 的描述 https://github.com/cline/cline/pull/{PR_NUMBER}
- 修复 2 的描述 https://github.com/cline/cline/pull/{PR_NUMBER}
```

展示最终总结：
- 新版本：v{VERSION}
- 标签已推送：是
- 包含的提交：（列出它们）
- Slack 消息已复制到剪贴板：是

提醒用户：
1. 在以下地址手动触发发布 GitHub Action：https://github.com/cline/cline/actions/workflows/publish.yml（粘贴 `v{VERSION}` 作为标签）
2. 发送 Slack 消息公告热修复

## 重要说明

- 此工作流不创建发布分支 - 仅创建标签
- 发布说明提交先进入 main，然后被挑选到标签上
- 这样既保持 main 的历史记录准确，又允许从标签发布热修复
- 如果挑选时出现冲突，请在继续之前解决
