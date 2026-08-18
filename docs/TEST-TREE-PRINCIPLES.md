# treespec 测试树编排原则

> 如何设计一棵好的测试树。核心思想：利用 docker commit 状态传递，让每个节点既消费父的状态、又为子创造状态，没有浪费的重复 setup。

## 原则 0：节点是状态，边是状态转移

### 核心模型

treespec 的测试树是一棵**状态树**：

- **节点 = 系统状态**（由 docker commit 产出的 image tag 标识）
- **边 = 状态转移**（由 spec.yaml 中的 steps 执行，改变系统状态）
- **目录名 = 动词短语**，描述这个转移做了什么

```
S₀ (base image)
  │
  ├── [add-provider]  ← 转移：添加 provider
  │     │
  │     ├── [add-model]      ← 转移：添加 model（在 provider 存在的状态上）
  │     │     │
  │     │     └── [add-session]  ← 转移：添加 session
  │     │
  │     └── [list-providers]     ← 观察：列出 providers
  │
  └── [add-bad-config]  ← 转移：添加错误配置（独立分叉）
        │
        └── [validate-rejects]    ← 观察：validate 应报错
```

**目录命名用动词短语**：

| ✅ 动词短语 | ❌ 名词/类别 | 区别 |
|:--|:--|:--|
| `add-provider` | `providers` | 动词表达"做了什么"；名词无法表达转移 |
| `run-all` | `curl-tests` | 动词表达动作；类别只是分类 |
| `validate-fresh` | `config` | 动词表达意图；名词只是一个东西 |
| `show-tree` | `tree` | 动词表达观察；名词只是对象 |

动词短语回答的核心问题：**"这个转移对系统做了什么？"**

```
父状态 --[add-provider]--> 子状态（provider 已添加）
父状态 --[run-all]-------> 子状态（测试结果已产出）
父状态 --[show-tree]------> 子状态（无变更，观察当前状态）
```

### 由此推出的原则

1. 按生命周期组织 → 转移的自然顺序就是工作流
2. 观察跟随动作 → 观察是一个边，必须在被观察状态之后
3. 状态依赖决定层级 → B 需要 A 的状态，则 B 是 A 的子节点
4. 隔离错误 → 错误转移在独立子树，不污染主线

## 原则 1：按生命周期组织，不按功能分类

### 为什么

treespec 的核心能力是 **docker commit 状态传递**——父节点的文件系统变更会传递给子节点。按生命周期组织（init→validate→add→run→observe），前一步的产物自然成为后一步的前提，最大程度减少重复的 precondition 准备。

按功能分类则每个 case 都要自建 fixture、自建项目、自建状态——16 个 case 16 套 setup，状态传递的优势完全浪费。

### step type 正交

所有 step 都是 exec 类型（用 curl 做 HTTP 测试）。不要按测试手段分类目录，要按业务意图组织。

### ❌ 按功能分类（错误）

```
spec/
  curl-requests/
    sends-get-request/       自建 fixture、自建 project
    sends-post-request/      自建 fixture、自建 project
  exec/
    executes-command/       自建 fixture、自建 project
  trace/
    writes-trace/           自建 fixture、自建 project
  cli/
    shows-tree/             自建 fixture、自建 project
    shows-help/             独立，无 project 依赖
```

每个 case 独立 setup，互相之间没有状态复用。16 棵 1 节点的树。

### ✅ 按生命周期组织（正确）

```
spec/
  bootstrap/
    spec.yaml                init project + install SUT（一次 setup）
    validate-fresh/         validate 初始状态
    add-specs/              一把梭 copy 所有 spec 树
      validate/             validate 全部 specs
      run-all/              run 全部 → pass + fail + skip
      run-with-trace/       run with trace → show trace
      show-tree/            tree 显示所有 specs
      add-bad-spec/         broken spec（隔离子树）
        validate-rejects/   validate → error
      add-no-primary/      branches without primary → error
```

一次 init，所有子节点共享项目状态。add-specs 一次添加所有 specs，孙节点共享 spec 文件。

## 原则 2：观察跟随动作

### 为什么

`treespec tree` 需要 case 存在才有意义。`treespec show` 需要 run 发生过才有 trace 文件。`treespec validate` 需要项目存在才能检查。

观察工具应该是**创造状态的那个节点的子节点**，而不是独立的平铺 case。这样它天然继承到被观察的状态，不需要自己重新构造。

### ❌ 观察独立 setup（错误）

```
shows-tree/
  spec.yaml: treespec tree --config assets/tree-fixture/treespec.yaml
  assets/tree-fixture/      # 专门为 tree 命令造的 fixture
    specs/alpha/...
    specs/group/beta/...
```

为了一次 `tree` 命令，专门造了一套 fixture。这个 fixture 在其他测试里也用不到。

### ✅ 观察作为动作的子节点（正确）

```
add-specs/                  ← 动作：添加 specs
  run-all/                  ← 动作：run
  show-tree/                ← 观察：tree（看到 add-specs 添加的 specs）
  run-with-trace/           ← 动作：run with trace
    spec.yaml:
      step 1: treespec run --output trace.jsonl
      step 2: treespec show trace.jsonl    ← 观察：show（看到 step 1 的 trace）
```

`show-tree` 是 `add-specs` 的子节点，committed state 里已经有 specs，直接 `tree` 即可。`show-trace` 在同一个节点的 step 2 里跑，step 1 的 trace 文件就在当前容器里。

## 原则 3：状态依赖决定层级

### 为什么

docker commit 链是 **parent→child 单向传递**。这是 treespec 的核心机制，编排原则必须围绕它展开。

- B 需要 A 的状态 → B 是 A 的子节点
- 兄弟节点各自独立——从父节点的 committed state 分叉，互不可见

这意味着两种结构模式：

### 链式（累积状态）

场景：先加 passing spec，再加 failing spec，再一起跑。

```
add-specs/                  ← 添加所有 specs
  run-all/                  ← run（看到所有 specs）
    add-more/               ← 添加更多 specs（看到 run-all 的状态 + 自己加的）
      run-again/            ← 再跑一次（看到所有 specs）
```

每个子节点在前面的基础上累积，dfs 顺序就是自然的工作流。

### 兄弟式（独立分叉）

场景：passing 和 failing 互不相关，各自从 init 状态分叉。

```
bootstrap/                  ← init project
  add-passing-spec/         ← 从 init 状态分叉，加 passing spec
    run-passing/            ← run（只看到 passing spec）
  add-failing-spec/         ← 从 init 状态分叉，加 failing spec
    run-fails/              ← run（只看到 failing spec）
```

`add-passing-spec` 和 `add-failing-spec` 是兄弟，各自从 `bootstrap` 的 committed state 出发，互不可见。这避免了 passing 和 failing spec 混在一起互相干扰。

### ❌ 不利用状态传递（错误）

```
test-a/
  spec.yaml: init project + add spec + run       # 全干一遍
test-b/
  spec.yaml: init project + add spec + run       # 又全干一遍
test-c/
  spec.yaml: init project + add spec + run       # 再全干一遍
```

每个 case 重复 init + add，docker commit 的优势完全没用上。

## 原则 4：隔离错误 case

### 为什么

一个 broken spec 会让 `validate` 报错。如果它和正常 specs 在同一条链上，后续所有 validate 都会被 broken spec 污染——你无法再验证"正常 case 的 validate 通过"。

错误 case 应该放在**独立子树**里，从主流程的分叉点出发，不污染主线。

### ❌ 错误 case 在主链上（错误）

```
add-specs/                  ← 添加 normal + broken specs
  validate/                 ← validate → error!（broken spec 污染了）
  run/                      ← run → scanSpecs 报错，无法执行
```

broken spec 一旦混入，整条链的 validate 和 run 都受影响。

### ✅ 错误 case 隔离（正确）

```
bootstrap/                  ← init project
  add-specs/                ← 主线：一把梭 copy 所有正常 specs
    validate/               ← validate → pass ✓
    run-all/                ← run → 正常执行
    add-bad-spec/           ← 分叉：独立加 broken spec
    validate-rejects/       ← validate → error ✓（预期行为）
```

`add-bad-spec` 和 `add-specs` 是兄弟，都从 `bootstrap` 的 init 状态出发。broken spec 只存在于 `add-bad-spec` 的子树里，不影响 `add-specs` 的主线。

## 总结

| 原则 | 核心思想 | 判据 |
|------|---------|------|
| 1. 按生命周期 | init→validate→add→run→observe | 树的层级是否对应工作流阶段？ |
| 2. 观察跟随动作 | 观察工具是动作的子节点 | show/tree/validate 是否在被观察状态之后？ |
| 3. 状态依赖决定层级 | B 需要 A → B 是 A 的子节点 | 每个节点是否消费父状态并为子创造状态？ |
| 4. 隔离错误 | broken case 在独立子树 | 错误 case 是否不污染主流程？ |

## 补充：clean 不能在树内部

`treespec clean` 删除所有 `treespec/ephemeral:*` 镜像。如果在树遍历过程中执行，会删掉树自己还在用的 commit chain tag，导致后续兄弟节点找不到父镜像而报错。

`clean` 必须是**自包含的顶层节点**：自己 init→run(parent-child, --keep-tags)→clean。注意叶子节点（无子节点、无 postcon）不会触发 `commitContainer`，所以必须用有子节点的 spec 来确保 ephemeral tag 被创建。

## 补充：commit 只在有继承者时触发

`treespec run` 对每个节点执行步骤后，只在 `hasChildren || hasPostcon` 时才 `commitContainer`。叶子节点不 commit——没有继承者就不浪费一次 docker commit。这是 treespec 的资源优化策略，但也意味着测试 `--keep-tags` 和 `clean` 时必须用有子节点的 spec。

---

**一句话**：treespec 的差异化价值不在"能跑测试"，而在"状态沿着树传递"。编排原则就是让这个传递链最大限度地被利用——没有浪费的重复 setup，没有遗漏的状态依赖。
