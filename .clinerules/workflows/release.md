# 发布

直接从 `main` 分支准备和发布版本。

## 概述

此工作流帮助你：
1. 选择/确认目标版本号
2. 手动编写面向最终用户的 `CHANGELOG.md` 条目
3. 确保 `package.json` 版本与变更日志一致
4. 创建并推送发布提交 + 标签
5. 触发发布工作流
6. 更新 GitHub 发布说明并分享摘要

## 流程

### 1) 同步并确定版本

```bash
git checkout main
git pull origin main
cat package.json | grep '"version"'
```

与维护者确认发布版本（补丁/次要/主要）。

### 2) 编写变更日志并更新版本

- 为目标版本编辑 `CHANGELOG.md`，使用人性化的发布说明。
- 确保版本标题使用方括号格式，例如 `## [3.66.1]`。
- 将 `package.json` 中的版本更新为相同值。

### 3) 提交并打标签

```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "v<version> Release Notes"
git push origin main
git tag v<version>
git push origin v<version>
```

### 4) 触发发布工作流

告知维护者运行：
https://github.com/cline/cline/actions/workflows/publish.yml

使用 `v<version>` 作为发布标签。

### 5) 更新 GitHub 发布说明

发布完成后：

```bash
gh release view v<version> --json body --jq '.body'
gh release edit v<version> --notes "<final curated release notes>"
```

### 6) 最终总结

提供：
- 已发布的版本/标签
- 发布页面链接
- 面向最终用户的主要变更摘要
