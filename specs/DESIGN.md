# treespec — 树状状态测试系统

> 状态：设计阶段，尚未进入工程实施

## 1 动机

传统的 CLI 测试工具是**扁平的执行路径**——每个 YAML 文件包含一条完整的 setup → action → verify 链，
路径之间无法复用，状态无法共享。

treespec 是**树状测试系统**：

- **节点** = 一个测试用例（执行步骤 + 判定）
- **边** = 状态依赖（子节点依赖父节点执行后的状态）
- **状态隔离** = `docker commit` 产出的 image tag

目标：

- 最大限度复用前置状态（一个 setup 被多个子节点共享）
- 失败剪枝（一个节点失败，只影响其子树）
- 资源可控（DFS 遍历，只保留当前路径上的 image）

---

## 2 基础模型

### 2.1 系统

一个系统是**状态空间 S** 和**变换集合 T** 的组合：

```
System = (S₀, {Tᵢ})

S₀  : 初始状态（base image tag）
Tᵢ  : 变换（transition），接收输入，改变状态，产生输出
```

每个变换 Tᵢ 的形式：

```
Tᵢ: (S, Iᵢ) → (S', Oᵢ)

S   : 变换前的系统状态（docker image tag）
Iᵢ  : 输入（CLI 命令 / HTTP request）
S'  : 变换后的系统状态（新的 docker image tag）
Oᵢ  : 输出（stdout, stderr, exit_code / HTTP response）
```

### 2.2 状态的隐晦性

系统状态 S 是**全局的、隐晦的**。我们无法直接观测 S 的完整内容，
只能通过探针（probe）来刺探 S 的部分信息。

这意味着：我们无法验证两个状态是否等价，因为我们无法全量比较 S。

### 2.3 树视角

由于无法验证状态等价性，采用**树视角**：

- 状态 S 由其**到达路径**唯一标识
- S = T[]，即从 S₀ 到达当前状态所经过的变换序列
- 空序列 [] 代表初始状态 S₀

```
S₀         = []                        (base image tag)
S₁         = [T_provider-add]          (commit 后的 tag)
S₂         = [T_provider-add, T_model-add]
S₃         = [T_provider-add, T_model-add, T_session-add]
```

树视角的好处：
- 每个状态有唯一的路径标识
- 路径本身就是 setup 过程
- 不需要额外的状态等价判定

---

## 3 测试用例

### 3.1 定义

一个测试用例 (TestCase) 是树上的一个**有向边**，定义为每个目录下的 `spec.yaml`：

```typescript
type Spec = {
  description: string;         // 用例描述（可选，详细文档用 .md 文件）
  env: string[];               // 所需环境变量（缺失则跳过并报告）
  steps: Step[];               // 主步骤（在 pre-condition 容器内执行）
  postcon: PostCondition[];    // 0~N 个后置条件（在 post-condition 容器内执行）
}

type PostCondition = {
  name: string;
  steps: Step[];
}

type Step = HttpStep | ExecStep

type HttpStep = {
  type: 'http';
  request: HttpRequest;
  timeout?: string;            // 如 "30s", "2m"
  assert?: Assertion;
  wait?: WaitConfig;
}

type ExecStep = {
  type: 'exec';
  command: string;
  timeout?: string;            // 如 "30s", "2m"
  assert?: Assertion;
  wait?: WaitConfig;           // 等待前置条件就绪
}

type WaitConfig = {
  timeout: string;             // 总等待上限，如 "2m"
  delay?: string;               // 两次执行间的间隔（非轮询周期），默认 "5s"
}

type Assertion = LlmAssertion | JsonataAssertion | RegexAssertion

type LlmAssertion = { type: 'llm'; prompt: string }
type JsonataAssertion = { type: 'jsonata'; expression: string }
type RegexAssertion = { type: 'regex'; conditions: { path: string; regex: string }[] }
```

TestCase 执行后，如果通过，产出一个新的 image tag：

```
S_post = docker commit(S_pre_container)
```

### 3.2 步骤与后置条件

TestCase 的 `steps` 和 PostCondition 的 `steps` **结构完全对称**——
都是 Step 数组，每个 step 有 command/request + optional assert。

区别仅在于**执行环境**：

| 属性 | steps（主步骤） | postcon（后置条件） |
|:-----|:---------------|:--------------|
| 执行容器 | pre-condition tag 启动的容器 | post-condition tag 启动的独立容器 |
| 执行时机 | 状态变换前 | 状态变换后（commit 后） |
| 生命周期 | 容器在步骤执行完后继续用于 commit | 容器用完即销毁 |
| 能力 | 可执行任意命令 | 可执行任意命令（包括 mutable） |

每个 step 的 `assert` 是可选的——中间步骤可以只关心执行成功，不做断言。

### 3.3 后置条件容器

后置条件跑在从 committed tag 启动的**独立容器**里：

| 属性 | 说明 |
|:-----|:-----|
| 生命周期 | 用完即销毁 |
| 隔离性 | 完全隔离，探针的任何操作不影响原始状态 |
| 能力 | 可执行任意命令（包括 mutable） |
| 数量 | 0~N 个，串行执行（省内存） |

后置条件容器串行执行，峰值内存 = 1 个 mutator 容器 + 1 个 postcon 容器。

### 3.4 容器文件访问

所有容器（mutator、postcon）在创建时挂载 **projectDir 为只读卷到 `/app`**：

```
-v <projectDir>:/app:ro --workdir /app/<spec>/<case-path>
```

- 项目源码、node_modules、dist 全程可读，无需在 Dockerfile 中安装
- `spec` 字段指定测试树根目录（相对于 projectDir），容器内为 `/app/<spec>`
- 每个 step 的 command 在自己的 case 目录（WORKDIR）内执行
- `assets/` 是保留目录名，scanner 跳过它不当子节点
- `docker commit` 不影响 mount（ro mount 不进 image layer，状态变更在容器可写层）

**Dockerfile 职责**：仅提供运行时环境（Node.js 等），不安装项目依赖。

```dockerfile
FROM node:22-alpine
WORKDIR /app
ENV PATH="/app/node_modules/.bin:$PATH"
```

项目内容全部从 mount 来。修改代码后无需重建 image，直接重跑即可。

**目录示例：**
```
project/
  treespec.yaml
  packages/
  node_modules/
  spec/                       # spec 目录
    provider-add/
      spec.yaml
      assets/                  # 保留目录名，scanner 跳过
        config.json
    model-add/
      spec.yaml
```

容器内访问：`cat spec/provider-add/assets/config.json`（从 WORKDIR 相对路径）。

**ro mount 与 docker commit 的交互**：

| 属性 | 说明 |
|:-----|:-----|
| mount 内容 | 不进 image layer，commit 不捕获 |
| 容器可写层 | commit 捕获，子节点可见 |
| 新容器 | 重新挂同一份 host 路径，看到最新内容 |

这意味着：项目源码变更在宿主修改后立即对所有新容器生效，无需重建 image。
容器内写入的文件（如数据库、配置）在容器可写层，被 commit 捕获。

**--no-mount（DinD）**：跳过 bind mount，假设项目已 COPY 进 image。WORKDIR 路径计算不变。

---

## 4 测试树

### 4.1 结构

所有 TestCase 构成一棵**以 S₀（base image tag）为根的树**。

```
S₀ (base image tag)
├── provider-add
│   ├── model-add
│   │   ├── prototype-add
│   │   │   ├── session-add
│   │   │   │   ├── session-stop
│   │   │   │   └── session-remove
│   │   │   └── prototype-update
│   │   └── model-update
│   └── provider-update
├── persona-add
│   └── persona-remove
└── help-command          (无子节点，不产生 commit)
```

### 4.2 失败剪枝

TestCase 的**任何判定失败**（step assert 或 postcon assert），都会导致**子树剪枝**：

| 失败类型 | 原因 | 结果 |
|:---------|:-----|:-----|
| **Step assert 失败** | 命令执行结果不符合预期 | 剪枝 |
| **Postcon assert 失败** | 状态验证不符合预期，子节点的 pre-condition 不保证成立 | 剪枝 |

剪枝语义：失败节点的**整个子树不可达**。

这符合测试的实际语义：如果 provider-add 的状态验证失败，
依赖它的 model-add、prototype-add、session-add 都不应该执行——
因为它们依赖的 pre-condition 已不可信。

### 4.3 森林

如果有多棵独立的树（互不依赖的测试路径），它们构成一个**森林**。
所有树的根共享同一个 base image tag（S₀）。

实际上可以视为一个虚拟根节点，所有实际根都是它的子节点。

### 4.4 树的组织方式

**目录树 = 测试树。** 目录嵌套 = 父子关系。

- **有 `spec.yaml`** = 测试节点（执行 steps + commit）
- **无 `spec.yaml`** = 组织节点（纯分组，直通 parent tag 给子节点，不执行不 commit）

```
spec/
  provider-add/                 # 测试节点
    spec.yaml
    README.md                   # 可选：文档说明
    model-add/
      spec.yaml
      prototype-add/
        spec.yaml
        session-add/
          spec.yaml
          session-stop/
            spec.yaml
          session-remove/
            spec.yaml
        prototype-update/
          spec.yaml
      model-update/
        spec.yaml
    provider-update/
      spec.yaml
  persona-add/
    spec.yaml
    persona-remove/
      spec.yaml
  self-test/                    # 组织节点 — 无 spec.yaml，直通 S0
    version/
      spec.yaml                 # 测试节点
    validate-ok/
      spec.yaml
  help-command/                 # 叶子测试节点
    spec.yaml
```

**规则：**
- 有 `spec.yaml` 的目录 = 测试节点（有 steps、可 commit）
- 无 `spec.yaml` 但有子目录 = 组织节点（直通 parent tag，不执行不 commit）
- 无 `spec.yaml` 且无子目录 = 报错（空节点无意义）
- 目录名 = 用例名（无需声明 `name`）
- 可选 `.md` 文件放在同目录做文档说明

**组织节点执行逻辑：**
```
execute(node, parent_tag):
  if node has spec.yaml:
    # 正常流程：steps → commit → postcon → children
    ...
  else:
    # 组织节点：直通 parent_tag 给子节点用
    for child in node.children:
      execute(child, parent_tag)
```

**消除了：** parent 引用、parent 校验、循环依赖检测——文件系统天然保证结构正确。

---

## 5 执行模型

### 5.1 DFS 遍历

采用**深度优先遍历**执行测试树。核心原则：**只保留当前 DFS 路径上的 image tag**。

### 5.2 执行流程

```
execute(node, parent_tag):
  # 步骤 1: 检查 env
  for env_var in node.env:
    if !is_set(env_var):
      report SKIP (missing env: env_var)
      return    # 级联剪枝：子节点标记为 SKIPPED (parent skipped)

  # 步骤 2: 从 pre-condition tag 启动容器
  container = docker run parent_tag

  # 步骤 3: 在容器内按顺序执行 steps
  for step in node.steps:
    output = exec_or_http(container, step, step.timeout)
    if step.assert && !evaluate(step.assert, output):
      report FAIL
      docker rm container
      return    # 剪枝：跳过 postcon 和子节点

  # 步骤 4: 是否需要 commit？
  need_commit = node.has_children OR node.has_postcon

  if need_commit:
    new_tag = docker commit container   # 产生 post-condition tag

  # 步骤 5: 从新 tag 启动后置条件容器，执行 postcon
  if node.has_postcon:
    postcon_container = docker run new_tag
    for postcon in node.postcon:
      for step in postcon.steps:
        output = exec_or_http(postcon_container, step, step.timeout)
        if step.assert && !evaluate(step.assert, output):
          report FAIL (postcon: postcon.name)
          docker rm postcon_container
          docker rmi new_tag
          docker rm container
          return    # 剪枝：postcon 失败也剪枝
    docker rm postcon_container

  # 步骤 6: 继续执行子节点
  if node.has_children:
    for child in node.children:
      execute(child, new_tag)
    docker rmi new_tag   # 所有子节点跑完，删掉这个 tag

  docker rm container
```

### 5.3 Commit 策略

**不是每个 test case 都需要 commit。** 只在以下情况 commit：

| 条件 | 是否 commit | 原因 |
|:-----|:------------|:-----|
| 有子节点 | ✅ | 子节点需要从 post-condition tag 启动 |
| 有后置条件 | ✅ | 后置条件需要从 post-condition tag 启动独立容器 |
| 叶子节点 + 无后置条件 | ❌ | 不需要保留状态，直接执行+判定即可 |

### 5.4 资源消耗

| 资源 | 消耗 | 原因 |
|:-----|:-----|:-----|
| **磁盘** | O(路径深度) | 只保留当前 DFS 路径上的 tag，已完成的 tag 立即删除 |
| **内存** | 1 mutator + 1 postcon | 后置条件串行执行，峰值两个容器 |
| **Docker 层数** | base 层数 + 路径深度 | `docker commit` 每次只增加 **1 层**（overlay2 增量层），不会增加多层 |
| **时间** | ~5-10 秒/case | 容器启动 + 命令执行 + commit，43 个 case ≈ 5-7 分钟 |

**Docker 层深度**：base image 通常 5-10 层，路径深度通常 < 20，总计 < 30 层，
远低于 Docker overlay2 的 127 层上限。不存在层深度问题。

---

## 6 与 Docker 的关系

### 6.1 黑盒视角

测试系统是**黑盒**的——它只关心 CLI 命令和输出，不关心被测系统的内部实现。
`docker commit` 是测试框架的基础设施能力，不是被测系统特有的。

### 6.2 Docker Image Chain

测试框架不依赖被测系统的 Docker image chain。它只需要一个 base image tag
作为入口（S₀），然后通过 `docker commit` 构建自己的状态链。

```
被测系统的 image chain:
  myapp/base:dev → myapp/runtime:dev → ...

测试框架的 tag chain（运行时动态产生）:
  base_tag → tag_provider-added → tag_model-added → ...
```

### 6.3 Tag 命名

测试过程中产生的 tag 使用统一前缀，方便清理：

```
treespec/ephemeral:<node-name>
```

测试结束后（正常或异常），清理所有 `treespec/ephemeral:*` tag。

---

## 7 项目配置：treespec.yaml

### 7.1 结构

```yaml
image:
  dockerfile: spec/Dockerfile
  tag: myapp-test:base            # base image tag（存在则跳过 build，--rebuild 强制重建）
  args:                           # 可选
    NODE_VERSION: "22"

projectDir: .                     # 项目根目录（默认 "."，相对于 treespec.yaml），挂载为 /app:ro

spec: spec                      # 测试树根目录（递归扫描 spec.yaml），相对于 projectDir

llm:                              # 可选，仅在使用 llm assertion 时需要
  base_url: "https://api.openai.com/v1"
  model: "gpt-4o"
  api_key_env: "OPENAI_API_KEY"

output: .treespec-output          # 可选
```

### 7.2 字段说明

| 字段 | 必填 | 说明 |
|:-----|:-----|:-----|
| `image.dockerfile` | ❌ | Dockerfile 路径（相对于 treespec.yaml）。可省略，改用 `--image` 传入已有 image |
| `image.tag` | ✅ | Base image tag。已存在则跳过 build，`--rebuild` 强制重建 |
| `image.args` | ❌ | Docker build args，key-value map |
| `projectDir` | ❌ | 项目根目录（相对于 treespec.yaml，默认 `"."`）。挂载为 `/app:ro` |
| `spec` | ✅ | 测试树根目录（相对于 projectDir），递归扫描含 `spec.yaml` 的子目录 |
| `llm.base_url` | ❌ | LLM API 端点（OpenAI 兼容，仅用 llm assertion 时需要） |
| `llm.model` | ❌ | LLM 模型名 |
| `llm.api_key_env` | ❌ | 存放 API key 的环境变量名（不直接写 key） |
| `output` | ❌ | 测试输出目录（默认 `.treespec-output`） |

**约定：** `.env` 文件放在 treespec.yaml 同目录，CLI `--env-file` 可覆盖。

**Docker build context** = treespec.yaml 所在目录（不可配置）。

### 7.3 CLI

```bash
treespec run                                # 跑完整测试树
treespec run --image myapp:latest           # 用已有 image，不 build
treespec run spec/provider-add/model-add/  # 跑子树（自动含祖先链）
treespec run spec/*/*/                     # glob 多个子树
treespec run --rebuild                      # 强制重建 base image
treespec run --env-file x.env               # 覆盖 .env
```

**image 来源优先级**：`--image` > `image.dockerfile`。两者都没有则报错。

### 7.4 Base Image 构建

Base image 由项目的 Dockerfile 构建，**仅包含运行时环境**：

- Node.js / Python 等运行时
- 系统级依赖（如 `git`, `curl`）
- `ENV PATH` 让 mount 进来的 `node_modules/.bin` 可直接调用

项目内容（源码、依赖、构建产物）不在 image 中——全部通过 `projectDir` mount 在运行时提供。

```dockerfile
# spec/Dockerfile
FROM node:22-alpine
WORKDIR /app
ENV PATH="/app/node_modules/.bin:$PATH"
```

修改代码后无需重建 image，直接 `treespec run` 即可用新代码重跑。

---

## 8 声明格式

### 8.1 TestCase 示例

```yaml
# spec/provider-add/spec.yaml
description: "添加 openrouter provider"
env:
  - OPENROUTER_API_KEY
steps:
  - type: exec
    command: "myapp provider add openrouter --api-key $OPENROUTER_API_KEY"
    assert:
      type: regex
      conditions:
        - { path: "stdout", regex: "provider 'openrouter' added" }
  - type: exec
    command: "myapp provider list"
    assert:
      type: jsonata
      expression: "$count(providers[name='openrouter']) = 1"
postcon:
  - name: verify-provider-persisted
    steps:
      - type: exec
        command: "cat /data/providers.json"
        assert:
          type: jsonata
          expression: "providers[0].name = 'openrouter'"
```

```yaml
# spec/provider-add/model-add/spec.yaml
description: "添加 claude-4-sonnet model"
env:
  - OPENROUTER_API_KEY
steps:
  - type: exec
    command: "myapp model add claude-4-sonnet --provider openrouter"
    assert:
      type: regex
      conditions:
        - { path: "exit_code", regex: "^0$" }
postcon:
  - name: verify-model-listed
    steps:
      - type: exec
        command: "myapp model list"
        assert:
          type: regex
          conditions:
            - { path: "stdout", regex: "claude-4-sonnet" }
```

### 8.2 环境变量

Step 的 command 和 HTTP request 中可以引用环境变量，
用于隔绝 token、密钥等敏感信息：

```yaml
- type: exec
  command: "myapp provider add openrouter --api-key $OPENROUTER_API_KEY"
- type: http
  request:
    method: POST
    url: "https://api.example.com/auth"
    headers:
      Authorization: "Bearer $API_TOKEN"
```

环境变量来源优先级：
1. Shell 环境变量
2. env_file 文件
3. TestCase 的 `env` 字段声明所需变量（缺失则 SKIP）

### 8.3 Assertion 类型

| 类型 | 结构 | 说明 |
|:-----|:-----|:-----|
| `regex` | `{ type: 'regex', conditions: [{ path, regex }] }` | 对指定路径的值做正则匹配 |
| `jsonata` | `{ type: 'jsonata', expression: '...' }` | 用 JSONata 表达式断言 JSON 输出 |
| `llm` | `{ type: 'llm', prompt: '...' }` | 用 LLM 判定输出是否符合预期 |

**regex** 的 `path` 支持：
- `stdout` / `stderr` — 命令输出
- `exit_code` — 退出码
- `status` — HTTP 响应状态码
- `body` — HTTP 响应体

### 8.4 LLM Assertion

LLM assertion 使用 OpenAI 兼容 API（`/chat/completions`），配置方式：

```yaml
# treespec.yaml
llm:
  base_url: "https://api.openai.com/v1"    # 或任何 OpenAI 兼容端点
  model: "gpt-4o"
  api_key_env: "OPENAI_API_KEY"            # 从环境变量读取 key，不硬编码
```

CLI 也可覆盖：

```bash
treespec run --llm-base-url https://api.openai.com/v1 --llm-model gpt-4o
```

**判定流程**：

1. 组装对话：system prompt（judge 角色定义）+ user messages（test case 上下文 + 步骤历史 + 当前步骤输出）
2. 发送到 LLM API（temperature=0, max_tokens=256）
3. 解析响应：正则提取 `VERDICT: PASS` 或 `VERDICT: FAIL` + `REASON: ...`
4. 返回判定结果

**System prompt** 定义 judge 角色和输出格式：

```
You are a test judge. You are given a test case's steps and their results.
Your job: determine if the output meets the expected criteria.

Reply in this exact format:
VERDICT: PASS
REASON: <one sentence explanation>

Or:
VERDICT: FAIL
REASON: <one sentence explanation of what went wrong>

Be strict but fair. Only PASS when the output clearly meets the criteria.
```

**上下文组装**：当前步骤之前的所有步骤（命令 + 输出 + 判定结果）作为对话历史喂给 LLM，
使其能理解完整的测试上下文，而不只是孤立的一步。

---

## 9 开放问题

1. **错误恢复** — 如果 `docker commit` 失败（磁盘满、Docker daemon 崩溃），
   如何恢复？是从头重跑还是从最近的 tag 恢复？

2. **并行分支** — 当前 DFS 是串行的。如果两个分支完全独立
   （比如 persona-add 和 provider-add），理论上可以并行。
   但并行意味着同时保留多个路径上的 tag，磁盘消耗增加。
   是否值得？

3. **CI/CD 集成** — 输出格式是什么？
   如何与 CI 系统集成（JUnit XML、GitHub Checks）？

4. **Step retry / timeout** — 更完善的重试机制设计（暂不纳入 MVP）。
