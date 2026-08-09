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

因此运行时的推论是：**状态沿着树传递。** 后一条边站在前一条边到达的状态上，不必重复 setup；某条边失败，则其后整棵子树剪掉——前提已不可信。

```
S₀ (Dockerfile → base image)
├──── add-provider ──→ S₁
│         └─── add-model ──→ S₂
│                   └─── run-session ──→ S₃
└──── add-persona ──→ S₄
```

| 概念 | 含义 |
|:-----|:-----|
| **S₀** | 初始状态；由 Dockerfile / base image 给出 |
| **节点** | 一个系统状态（路径标识；实现上是 image tag） |
| **边** | 一次状态转移（`spec.yaml`；刺激为命令或 HTTP） |
| **传递** | 子边继承父边 commit 后的状态 |
| **剪枝** | 边失败 → 后续子树跳过 |

## 3. 主路径怎么走？

从零到第一次跑通：

```bash
npm i -g treespec
treespec init my-project && cd my-project
treespec run
```

最小 `spec.yaml`（一条从 S₀ 出发的边）：

```yaml
description: "echo hello"
steps:
  - type: exec
    command: "echo hello"
    assert:
      type: regex
      conditions:
        - { path: stdout, regex: "hello" }
```

典型项目骨架：

```
my-project/
  treespec.yaml          # 项目配置
  spec/
    Dockerfile           # S₀：初始状态
    add-provider/        # 边：目录名 = 转移名
      spec.yaml
      add-model/         # 边：站在 add-provider 到达的状态上
        spec.yaml
```

规则直觉：Dockerfile 是根状态；有 `spec.yaml` 的目录是边；嵌套即接在上一状态之后；上游失败则下游剪掉。

---

## 相关

- （待写）人与 Agent 的 TDD 协作环（五步细则）
- （待写）状态落盘与 docker commit
- （待写）如何设计覆盖树
- （待写）如何跑测试与读结果
