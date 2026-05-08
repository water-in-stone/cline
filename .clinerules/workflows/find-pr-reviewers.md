# 为当前分支寻找最佳审查者

分析当前分支，基于**领域专长**和 git 历史记录找到最适合审查 PR 的人选。

## 步骤

1. 获取当前分支名称并确认不是 `main` 分支
2. 获取当前分支与 `origin/main` 之间的差异：
   - 使用 `git diff origin/main...HEAD --name-only` 获取变更的文件
   - 使用 `git diff origin/main...HEAD` 理解变更的性质和意图
3. **识别正在变更的领域/功能区域**：
   - 仔细阅读差异，理解概念上正在变更什么（例如："斜杠命令"、"认证"、"API 客户端"、"UI 组件"）
   - 这种语义理解对于找到合适的审查者至关重要
4. 通过搜索相关文件及其贡献者来寻找领域专家：
   - 识别与该功能/领域相关的所有文件（不仅仅是被修改的文件）
   - 示例：如果修改了斜杠命令，找到代码库中所有与斜杠命令相关的文件
   - 使用 `git log --format="%an <%ae>" -- <related-files-pattern>` 查找该领域的专家
5. 获取额外的上下文信息：
   - `git blame -L <start>,<end> origin/main -- <file-path>` 用于精确定位变更的行
   - 相关文件的近期提交活动
6. 对贡献者进行评分和排名：
   - **最高权重：领域专长** - 在该功能区域的文件中拥有最多提交的人（包括本次 PR 未触及的文件）
   - **中等权重：直接文件专长** - 对正在修改的特定文件的提交
   - **较低权重：行级所有权** - 编写了正在被修改的确切代码行
7. 排除自己（与 git config user.email 比对）
8. 以有序列表展示前 5 名审查者

## 输出格式

输出一个有序列表：

1. **姓名** - 领域专家：对斜杠命令相关文件有 15 次提交，编写了核心解析逻辑
2. **姓名** - 对受影响文件有 8 次提交，最近添加了正在修改的功能
3. ...

## 命令参考
```bash
git config user.email
git diff origin/main...HEAD --name-only
git diff origin/main...HEAD
# 查找某个领域的相关文件（根据从差异中了解到的信息调整匹配模式）
find . -type f \( -name "*slash-command*" -o -name "*SlashCommand*" \) | head -20
# 获取相关文件的贡献者
find . -type f \( -name "*slash-command*" -o -name "*SlashCommand*" \) -print0 | xargs -0 git log --format="%an <%ae>" -- | sort | uniq -c | sort -rn
git log --format="%an <%ae>" -- <file> | sort | uniq -c | sort -rn
git blame -L 10,20 origin/main -- <file>
```

不要提问 - 直接分析变更，识别领域，输出审查者列表。
