# treespec

> 用测试用例树描摹 app 的全生命周期行为，在人与 Agent 之间建立一套共同可见、可编辑、可执行的行为标准。

## 解决什么问题

传统扁平的 E2E 测试有三个痛点：

1. **case 之间相互独立，看不到行为全貌** — 每个用例是一条独立的执行路径，用例之间的关系无从体现，无法从整体上理解 app 的行为边界。

2. **大量重复的前置条件搭建，浪费运行时间** — 每个用例从头跑完整 setup，相同的前置步骤在不同用例间反复执行。

3. **硬编码的程序断言在 e2e 场景约束太片面** — regex / jsonata 只能匹配固定模式，面对复杂的自然语言输出、多步骤累积的上下文，传统断言力不从心。

## 核心特性

### 🌳 一棵树描述行为全貌

目录嵌套即父子关系，从初始化到最终状态，app 的整个生命周期就是一棵树。一眼看见全貌，不需要脑补用例之间的隐含关系。

```
add-provider/
├── add-model/
│   ├── run-session/
│   │   ├── stop-session/
│   │   └── remove-session/
│   └── update-model/
└── update-provider/
add-persona/
└── remove-persona/
```

### ♻️ 状态复用，提升效率

父节点执行后的状态自动传递给子节点——一个 setup 被整棵子树共享，不重复跑。失败自动剪枝：一个节点挂了，依赖它的子树全部跳过。

### 🔍 程序化 & LLM 断言

支持三种断言方式，各擅胜场：

```yaml
# regex — 简单模式匹配
assert:
  type: regex
  conditions:
    - { path: stdout, regex: "provider 'openrouter' added" }

# jsonata — 结构化数据断言
assert:
  type: jsonata
  expression: "$count(providers[name='openrouter']) = 1"

# llm — 语义判断，处理复杂输出
assert:
  type: llm
  prompt: "输出中是否包含至少一个中文 provider 名称？"
```

LLM 断言让 AI 充当 judge，判断输出是否符合预期语义——面对自然语言、多步骤累积上下文等场景，比硬编码模式灵活得多。

## 快速上手

```bash
npm i -g treespec
treespec init my-project && cd my-project
treespec run
```

### 最小 spec.yaml

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

### 项目结构

```
my-project/
  treespec.yaml          # 项目配置
  spec/
    Dockerfile           # 运行时环境（仅包含 Node.js 等基础运行时）
    add-provider/
      spec.yaml          # 添加 provider
      add-model/
        spec.yaml        # 添加 model（继承父状态，无需重复 setup）
        run-session/
          spec.yaml      # 运行 session（继续继承）
    add-persona/
      spec.yaml          # 独立分支，从根状态开始
```

**规则：** 有 `spec.yaml` 的目录 = 测试节点，没有的 = 纯组织节点（分组用，不执行）。目录名 = 用例名。`assets/` 为保留目录，存放测试资源。

## CLI

```bash
treespec run                         # 跑完整测试树
treespec run spec/add-provider/      # 跑子树（自动含祖先链）
treespec run --image myapp:latest     # 用已有 image，不 build
treespec run --rebuild                # 强制重建 base image
treespec tree                         # 可视化测试树结构
treespec show <trace.jsonl>           # 回放测试结果
treespec validate                     # 检查配置 + spec 树
treespec clean                        # 清理临时 image tag
```

## 文档

- [DESIGN.md](docs/DESIGN.md) — 完整设计文档（状态模型、执行流程、资源策略）
- `treespec help` — CLI 帮助

## License

MIT © Shazhou Family
