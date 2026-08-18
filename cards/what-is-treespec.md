# treespec 是什么

> 用测试用例树描摹 app 的全生命周期行为，在人与 Agent 之间建立一套共同可见、可编辑、可执行的行为标准。

## 1. 解决什么问题？给谁用？

**给谁用：** 人与 Agent **一起用**——不是两套文档，而是同一份可读写可跑的行为契约。

**解决什么：** 协作开发缺少「双方都能当真源」的行为规格。人定意图与边界；Agent 起草、执行、按失败 trace 排障。协作环是：提案 → review → 编写自检 → 跑测（全树或子树）→ trace 定位。

**适用范围：** CLI 工具与 HTTP 服务；不适用 GUI。随着 CLI 成为 Agent 操作电脑的主界面，这类契约会越来越必要。

## 2. 核心抽象是什么？

应用的全部行为，理想上是一张**状态机**。完整的图往往画不清、也验不完；treespec 从初始状态出发，用一棵**测试树**去覆盖其中有意义的行为等价类——这棵树就是人与 Agent 共享的那份契约长什么样。

**根是 S₀，不是某个 spec。** Dockerfile（及其 build 出的 base image）描述初始状态；树上每一条边才是一次状态转移。目录里的 `spec.yaml` 是边，不是节点。`spec/` 下并列的多个用例，都是从同一 S₀ 伸出的第一层边，因此整体是一棵树，不是森林。

**边做什么：** 对 CLI 是命令，对 HTTP 服务是请求（一条边里可有多个步骤）。转移成功后，框架 `docker commit` 容器，得到下一状态。这要求被测系统把契约相关状态**落在容器可写层的磁盘上**——只有这样，commit 才代表可继承的完整状态。状态节点多半匿名，由到达路径标识；目录名用动词短语，命名的是边。

**Postcon** 挂在到达的状态上：从已 commit 的 tag 另起容器做确认（探针，不是下一条边）。探针里的副作用不传给后续边；确认失败同样剪枝。

同一状态下若有多条出边，用 **主线**（`primary`）标出生命周期正线，其余为分叉（`branches`）。人与 Agent 默认沿主线读契约；分叉用来覆盖旁路行为，不打断正线叙事。

因此运行时的推论是：**状态沿着树传递。** 后一条边站在前一条边到达的状态上，不必重复 setup；某条边或其后置确认失败，则后续子树剪掉——前提已不可信。

举例（假设被测对象是 **git CLI**；S₀ 的 Dockerfile 里已装好 `git`，工作区为空）：

```
S₀ (Dockerfile → base image)
└──── git-init ──→ S₁                         ← 主线
          └─── add-readme ──→ S₂              ← 主线
                    └─── first-commit ──→ S₃  ← 主线
                              postcon: git log / status   ← 确认 S₃，不是边
                              ├── amend-commit ──→ …      ← 主线（继续正线）
                              └── create-branch ──→ …     ← 分叉
```

| 概念 | 含义 |
|:-----|:-----|
| **S₀** | 初始状态；由 Dockerfile / base image 给出 |
| **节点** | 一个系统状态（路径标识；实现上是 image tag） |
| **边** | 一次状态转移（`spec.yaml`；刺激为命令或 HTTP） |
| **主线** | `primary` 标出的生命周期正线；其余出边为分叉 |
| **postcon** | 对到达状态的探针确认；非边，不改变后续继承的状态 |
| **传递** | 子边继承父边 commit 后的状态 |
| **剪枝** | 边或 postcon 失败 → 后续子树跳过 |

## 3. 主路径怎么走？

仍以 **git CLI** 为例。从零到第一次跑通：

```bash
npm i -g treespec
treespec init my-project && cd my-project
# 按需改 Dockerfile：安装 git，作为 S₀
treespec run
```

最小的一条边——`spec/git-init/spec.yaml`（从 S₀ 出发）：

```yaml
description: "initialize a git repository"
steps:
  - command: "git init"
    assert:
      type: regex
      conditions:
        - { path: stdout, regex: "Initialized empty Git repository" }
postcon:
  - name: has-git-dir
    steps:
      - command: "test -d .git"
```

项目骨架（完整主线 / 分叉见上一节的树）：

```
my-project/
  treespec.yaml
  spec/
    Dockerfile             # S₀：含 git 的空环境
    git-init/
      spec.yaml            # 上面的最小边
      add-readme/
        spec.yaml
        first-commit/
          spec.yaml        # 可挂 postcon；其下再分主线 / 分叉
```

规则直觉：Dockerfile 是根状态；有 `spec.yaml` 的目录是边；嵌套接在上一状态之后；`primary` 标主线；上游失败则下游剪掉。

---

## 相关

- （待写）人与 Agent 的 TDD 协作环（五步细则）
- （待写）状态落盘与 docker commit
- （待写）如何设计覆盖树
- （待写）如何跑测试与读结果
