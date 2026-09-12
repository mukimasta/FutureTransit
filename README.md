# FutureTransit MVP

这是 FutureTransit 重新设计后的 MVP 工作分支。

旧版可玩 Demo 已完整保存在 Git 标签 `demo-v0.1` 和 `main` 分支中；本分支不继承旧版实现，避免旧玩法和旧架构限制新版设计。

## 当前阶段

先确定 MVP 的核心体验与边界，再选择技术方案和建立代码结构。

下一步填写 [`docs/MVP_BRIEF.md`](docs/MVP_BRIEF.md)，确认后再开始实现。

## 版本约定

- `main`：旧版 Demo 的冻结快照
- `demo-v0.1`：旧版 Demo 的永久标签
- `mvp`：新版 MVP 的开发分支

查看旧版时运行 `git switch main`，返回新版时运行 `git switch mvp`。
