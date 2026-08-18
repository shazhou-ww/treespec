# Writing Test Cases

How to write treespec test cases: spec.yaml format, step types, assertions,
wait, postcon, tree design principles, and worked examples.

## 0. How treespec Works

treespec is a **tree-structured, stateful test system**. It runs tests as a
tree of Docker containers, where each node is both a **state** and the
**transition** that produced it.

### Core model

```
                    Dockerfile
                       │
                       ▼
                   base image (S₀)
                       │
                ┌──────┴──────┐
                │             │
            node A          node B        ← each node = one Docker container
          (state S_A)    (state S_B)         started from parent's image
                │
          ┌─────┴─────┐
          │           │
        node A1     node A2     ← child containers started from A's committed image
```

- **Node = state + edge.** Each node is a state in the system, reached by
  executing the parent's steps. The node's `spec.yaml` defines the *edge* —
  the transition from the parent's state to this node's state.
- **Container per node.** Each test node runs in its own Docker container.
  The root node's container is built from a Dockerfile (the base image, S₀).
  Child nodes start from the parent's committed image — they inherit the
  parent's filesystem state.
- **Edge = steps + assertions.** Each `spec.yaml` declares steps (shell
  commands or HTTP requests) to execute inside the container, and assertions
  to verify the result. Steps mutate the container's state; assertions check
  it. If all assertions pass, the container is `docker commit`-ed into a new
  image tag that child nodes will start from.
- **Postcon = snapshot verification.** After steps complete and the image is
  committed, postcon runs in a **fresh container** from that committed
  snapshot. This lets you verify persisted state — e.g., "did the file
  survive?" or "is the database row still there?" Postcon can perform
  mutable operations (write, delete, modify) on the snapshot without
  affecting the committed image or subsequent nodes.

### Execution flow

```
1. Build base image from Dockerfile (S₀)
2. Start container from S₀ (or parent's tag)
3. Execute steps via docker exec
   ├── assert passes → docker commit → new image tag
   └── assert fails   → node FAIL, prune subtree
4. Run postcon in fresh container from committed tag
   ├── pass → children can proceed
   └── fail → node FAIL, prune subtree
5. Recurse into children (DFS)
```

### Node types

| Type | Has `spec.yaml`? | Role |
|---|---|---|
| **Test node** | Yes | Part of the test tree. Executes steps, asserts, may commit. |
| **Assets node** | No | Fixture data (configs, inputs). Not part of the test tree. |

### Child discovery

Children are **explicitly declared** in `spec.yaml` via `primary` (the
main-line child) and `branches` (side branches). Directory nesting alone
does not create parent-child relationships.

## 1. Test Tree Structure

The directory tree IS the test tree. Test nodes are folders with `spec.yaml`;
assets nodes (folders without `spec.yaml`) are fixture data, not part of the
tree.

```
spec/                         # specs root (configurable in treespec.yaml)
├── provider-add/              #   test node (has spec.yaml)
│   ├── spec.yaml             #   ← declares primary: model-add
│   ├── config.json           #   fixture files directly in the node dir
│   ├── data/                 #   assets node (no spec.yaml → fixture data)
│   │   └── seed.sql          #   accessible at /app/spec/provider-add/data/
│   └── model-add/            #   child test node (declared in parent's primary)
│       └── spec.yaml
└── standalone-test/
    └── spec.yaml             #   leaf node (no children → no commit)
```

Rules:
- Has spec.yaml → test node (executes steps, may commit)
- No spec.yaml → assets node (fixture data, not part of the test tree)
- Directory name = node name (verb phrase recommended)
- Children are explicit: declare them in `primary` and/or `branches`
- A subdirectory with spec.yaml not listed in primary/branches → warning

## 2. spec.yaml Format

```yaml
description: "what this test verifies"   # optional but recommended
env:                                       # optional, required env vars
  - API_KEY                                #   missing → SKIP this node + children
steps:                                     # required
  - type: exec                             #   exec | http
    command: "some command"                #   required for exec
    cwd: "/workspace"                      #   optional, working dir inside container
    description: "do something"            #   optional, human-readable
    timeout: "30s"                         #   optional, per-step
    wait:                                  #   optional — poll until ready
      timeout: "30s"                       #     total wait timeout
      delay: "2s"                          #     gap AFTER step, before re-check
    assert:                                #   optional — omit for transition step
      type: regex                          #   regex | jsonata | exit_code | llm
      conditions: [...]                    #   (see assert types below)
postcon:                                   # optional, post-condition verification
  - name: verify-state
    steps: [...]                           #   same Step[] format, runs in fresh container
```

Minimal example:
```yaml
description: "echo hello"
steps:
  - type: exec
    command: "echo hello"
    assert:
      type: regex
      conditions:
        - { path: "stdout", regex: "hello" }
```

## 3. Step Types

### type: exec — Run a shell command inside the container

```yaml
- type: exec
  command: "echo hello"
  timeout: "10s"
  assert: { type: regex, ... }
```

### type: http — Send an HTTP request from inside the container

Uses `node -e fetch` internally. URL can be `localhost:PORT` to access services
started in the same container. No `network: host` needed — http and exec share
the same network namespace.

```yaml
- type: http
  request:
    method: POST
    url: "https://api.example.com/endpoint"
    headers:
      Content-Type: "application/json"
      Authorization: "Bearer $API_TOKEN"
    body:
      key: "value"
  assert: { type: jsonata, ... }
```

HTTP steps support `$VAR` and `${VAR}` env substitution in url, headers, body.

## 4. Assertion Types

### type: regex — Match patterns against step output paths

```yaml
assert:
  type: regex
  conditions:
    - { path: "stdout", regex: "hello" }
    # exit_code=0 is checked implicitly — no need to add it explicitly
```

Paths: `stdout` | `stderr` | `exit_code` (exec) | `status` | `body` | `headers.*` (http)
All conditions must match → PASS. Any miss → FAIL.
Note: exec steps with assert also implicitly check exit_code=0.

### type: jsonata — JSONata expression evaluated against a context object

```yaml
assert:
  type: jsonata
  expression: "status = 200 and json.hello = 'world'"
```

Context for exec: `{ stdout, stderr, exit_code }` (stdout parsed as JSON if possible)
Context for http: `{ status, body, headers, json }` (body parsed as JSON if possible)
Truthy result → PASS.

### type: llm — LLM reads step output + judge prompt, returns verdict

```yaml
assert:
  type: llm
  prompt: "Does the output contain the word hello?"
```

Requires `TREESPEC_LLM_BASE_URL`, `TREESPEC_LLM_MODEL`, `TREESPEC_LLM_API_KEY`
env vars. LLM receives: test description + step history + current step output +
prompt. Returns `VERDICT: PASS` or `VERDICT: FAIL + REASON: <explanation>`.
temperature=0, max_tokens=256.

### type: exit_code — Check exit code explicitly

```yaml
assert:
  type: exit_code
  equals: 0                          # optional, default 0
```

### (omit assert) — Transition step

Exit 0 = PASS, non-zero = FAIL. Use for setup steps (cd, mkdir, cp) where you
only care that the command succeeded.

### Decision guide

```
Pattern matching on output?       → regex
Extract/validate structured data? → jsonata
Just check exit code?             → exit_code (or omit assert)
Need semantic judgment?           → llm
Just cd/mkdir/setup?              → omit assert
```

## 5. Wait (Polling for Async Operations)

```yaml
steps:
  - type: exec
    command: "rm -f /tmp/ready; (sleep 3 && echo ready > /tmp/ready) &"
  - type: exec
    command: "cat /tmp/ready"
    wait:
      timeout: "30s"     # total time to keep retrying
      delay: "2s"         # gap AFTER each attempt before re-running
    assert:
      type: regex
      conditions:
        - { path: "stdout", regex: "ready" }
```

Semantics: "not ready yet, wait and re-check" — NOT "failed, retry".
Step re-executes until assert passes or timeout. Only PASS/FAIL (no RETRY).

## 6. Postcon (Post-Condition Verification)

```yaml
postcon:
  - name: verify-state-committed
    steps:
      - type: exec
        command: "cat /tmp/state"
        assert: { type: regex, ... }
```

Runs in a FRESH container from the committed image (after steps complete).
Use case: verify that state was persisted via docker commit.
Postcon container is isolated — mutations don't affect the committed image.
Multiple postcons run serially (peak: 1 mutator + 1 probe container).
Postcon failure → same as step failure: prune children.

## 7. Container Runtime & Dockerfile

### How Containers Start

Each test node runs in a Docker container created from the base image (or
parent's committed image). The container is **long-running** — it starts with
`sleep infinity` and stays alive while steps are executed via `docker exec`.

```
┌─────────────────────────────────────────────┐
│  Container (from base image or parent tag) │
│                                             │
│  /app/                    ← projectDir :ro  │  (bind mount from host)
│    ├── spec/              ← specs root      │
│    │   ├── provider-add/  ← current node    │  ← WorkingDir
│    │   │   ├── spec.yaml                     │
│    │   │   ├── config.json   ← fixture files  │
│    │   │   └── data/        ← assets node     │
│    │   │       └── seed.sql  (no spec.yaml)   │
│    │   └── model-add/                      │
│    ├── package.json                          │
│    ├── node_modules/   (skipped in build)   │
│    └── dist/          (skipped in build)   │
│                                             │
│  Cmd: sleep infinity                        │
│  Privileged: true  (for DinD)               │
│  Network: bridge (configurable)            │
└─────────────────────────────────────────────┘
```

Key properties:

- **`/app` — project root, mounted read-only** from `projectDir` (default:
  treespec.yaml's directory). All project source, config, and node_modules
  are visible inside the container at `/app`. Read-only — test steps cannot
  modify project files (state mutations happen via docker commit, not
  filesystem writes to /app).
- **WorkingDir** — set to `/app/<specRelative>/<nodePath>`. For example,
  if `spec: spec` and the current node is `provider-add`, the working
  directory is `/app/spec/provider-add`. Step commands run from here.
- **Assets** — any subdirectory without `spec.yaml` is an assets node. It
  is not part of the test tree (no steps, no commit). Fixture files are
  accessible inside the container at `/app/<specRelative>/<nodePath>/<dir>/`.
  The directory name is arbitrary — `data/`, `fixtures/`, `config/`, etc.
- **Environment** — env vars from `.env` file and shell environment are
  injected into the container. The `env` field in spec.yaml declares
  required vars (missing → SKIP this node).
- **Network** — default: bridge. Set `docker.network: host` in
  treespec.yaml for host networking. HTTP steps run inside the container
  via `node -e fetch`, so they can access container-local services
  (`localhost:PORT`) regardless of network mode.
- **Privileged mode** — containers run privileged, required for DinD
  (Docker-in-Docker). Each container runs its own `dockerd`; no host
  `docker.sock` is mounted. This means test steps can build images and run
  sibling containers inside the test container.

### Dockerfile: Mount Mode vs Build Mode

The base image (S₀) is built from the Dockerfile specified in
`image.dockerfile`. There are two approaches:

#### Mount Mode (default)

The Dockerfile is minimal — just sets up the base image with system deps.
The project directory is mounted read-only at `/app` at runtime. Source code,
`node_modules`, and built artifacts are all from the host — no rebuild needed
when code changes.

```dockerfile
FROM node:22-alpine
WORKDIR /app
ENV PATH="/app/bin:/app/node_modules/.bin:$PATH"
```

Because `/app` is a bind mount, everything under the project directory on the
host is visible inside the container — including host-compiled `node_modules/`
and `dist/`. This is fast but may break if the host and container have
different libc (e.g. host glibc, container Alpine musl).

**Pros:** Fast iteration — change code on host, re-run immediately.
**Cons:** Host-compiled native modules may not work in the container. Modules
like `better-sqlite3`, `sharp`, `canvas` are compiled for the host's libc,
which may not match the container's libc.
**Best for:** Pure JS/TS projects, or projects whose dependencies are all
pure JS.

#### Build Mode (Dockerfile Build)

The Dockerfile is complete — COPY + install + build all inside the container.
Everything is compiled in the correct environment. Use a **different WORKDIR**
(e.g. `/opt/project`) to avoid the `/app` bind mount overlaying the
baked-in files.

```dockerfile
FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /opt/project
COPY . .
RUN npm install
RUN npx tsc --build

RUN ln -sf /opt/project/node_modules/.bin/* /usr/local/bin/
ENV PATH="/opt/project/bin:/opt/project/node_modules/.bin:$PATH"
```

Note: `/app` is still mounted (read-only) in every container — this is
hardcoded. Build mode works by installing the project to a **different path**
(`/opt/project`), so the `/app` mount doesn't shadow it. The `/app` mount
still provides read-only access to project source if needed.

Run with `--rebuild` to force image rebuild when dependencies change.

**Pros:** Full compatibility — native modules compiled for the correct
libc/arch.
**Cons:** Slow iteration — every source change requires `--rebuild`, which
rebuilds the entire image from scratch. The Dockerfile `COPY . .` copies from
the build context (host project dir), which introduces host-path dependency.
**Best for:** Rarely-changed projects, or one-off builds where iteration speed
is not a concern.

#### Build Mode (Runtime Build) — recommended

Instead of baking source + build into the Dockerfile, keep the Dockerfile
minimal (system deps + toolchain only) and move install + build into the
**root node's steps**. Source code is read from the `/app:ro` mount (a
fixed, deterministic path), avoiding host pwd drift.

**Dockerfile** — system deps + toolchain only, rarely needs rebuild:

```dockerfile
FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /opt/project
ENV PATH="/opt/project/node_modules/.bin:$PATH"
```

**Root node** — copy source from `/app` mount + install + build:

```yaml
# spec/bootstrap/spec.yaml
steps:
  - name: install-deps
    command: cp /app/package.json /app/pnpm-lock.yaml /opt/project/ && pnpm install --frozen-lockfile
  - name: build
    command: cp -a /app/src /app/tsconfig.json /opt/project/ && pnpm build
```

After steps pass, `docker commit` captures the full build → base image S₀.

**Why this is better than Dockerfile Build:**

1. **Image is stable** — Dockerfile only has system deps, so the image tag
   rarely changes. No `--rebuild` needed when source or deps change.
2. **Source from fixed path** — `/app:ro` is always the project root, mounted
   by treespec. No reliance on build context or host pwd.
3. **Fast iteration** — source changes only re-run the root node's steps
   (copy + build), not a full Docker image rebuild.

**Advanced: deps caching via commit chain**

Split install and build into parent-child nodes. When only source changes,
the deps node's committed image is reused (image tag exists → skip), and only
the build node re-runs:

```yaml
# spec/deps/spec.yaml — install deps only, cached when lockfile unchanged
steps:
  - name: install
    command: cp /app/package.json /app/pnpm-lock.yaml /opt/project/ && pnpm install --frozen-lockfile
```

```yaml
# spec/deps/build/spec.yaml — child of deps, copy source + build
steps:
  - name: build
    command: cp -a /app/src /app/tsconfig.json /opt/project/ && pnpm build
```

When `pnpm-lock.yaml` changes → both nodes re-run (correct behavior).
When only source changes → only `deps/build` re-runs (fast, deps already
in parent's committed image).

#### Comparison

| | Mount Mode | Dockerfile Build | Runtime Build |
|---|---|---|---|
| Dockerfile | Minimal (system deps) | Complete (COPY + install + build) | Minimal (system deps) |
| Source | Host bind mount `/app:ro` | Baked into image (COPY from context) | `/app:ro` mount (fixed path) |
| Install + build | On host | In Dockerfile (image build time) | In root node steps (runtime) |
| Image rebuild trigger | Never | Source or deps change | System deps change only |
| Iteration speed | Fastest | Slowest | Fast (re-run root steps) |
| Native module compat | Host-dependent ✓* | Container-native ✓ | Container-native ✓ |
| WORKDIR | `/app` (matches mount) | `/opt/project` | `/opt/project` |

\* Only when host and container share the same libc.

#### Build Context Exclusions

`buildImage` always excludes these from the Docker build context:

```
.git  node_modules  dist  .treespec-output
```

In Dockerfile Build mode, you must run `npm install` and `tsc --build`
**inside** the Dockerfile — don't rely on host-compiled `dist/` or
`node_modules/` being available during image build.

In Runtime Build mode, this is not a concern — install and build happen in
container steps from the `/app` mount, not during `docker build`.

#### Choosing

```
Pure JS project?                        → Mount mode (default)
Native modules (better-sqlite3, sharp)? → Runtime Build mode
Host and container same libc?           → Mount mode works
Host glibc, container Alpine (musl)?    → Runtime Build mode
Need fast iteration + container-native? → Runtime Build mode (recommended)
```

## 8. Docker Commit Chain (State Isolation Model)

```
Parent node executes steps → docker commit → new image tag.
Child node starts a container FROM that tag → sees parent's state.
DFS traversal: only current path's tags exist (O(depth) disk).

writes-state/           # echo data > /tmp/state → commit
  reads-state/          # cat /tmp/state (sees parent's data) → commit
    reads-deep/         # still sees ancestor's data

Leaf nodes (no children, no postcon) → no commit (just execute + assert).
```

### Failure Pruning

Any assertion failure (step or postcon) → node FAIL → entire subtree pruned.
Children show as SKIP. This prevents testing on untrusted state.

```
fails-on-purpose/          # exit 1 → FAIL
  should-be-skipped/       # SKIP (parent failed, state untrustworthy)
```

## 9. Tree Design Principles

### Core model: nodes are STATES, edges are TRANSITIONS

Each directory with spec.yaml = an edge (a transition from parent's committed
state to a new state). The directory name should be a VERB PHRASE describing
the action that causes the transition:

```
add-provider/        ← "add a provider" → state now has a provider
run-all/             ← "run all specs" → state now has test results
show-tree/           ← "show the tree" → observe current state
validate-fresh/     ← "validate fresh project" → assert initial state
```

NOT nouns or categories:
```
providers/           ← what about them? not an action
http-tests/          ← a category, not a transition
config/              ← a thing, not something you do
```

The verb phrase answers: "what does this transition DO to the system?"
```
parent state --[add-provider]--> child state (provider added)
parent state --[run-all]--------> child state (results produced)
```

### Principles

1. **Organize by lifecycle, not by feature.**
   init → validate → add → run → observe
   Step types (exec, http), pass/fail variants — these are orthogonal
   to the lifecycle. They are parallel variants within a stage,
   not separate test categories.

2. **Observation follows action.**
   show-tree after cases exist; show-trace after a run happened.
   A node that observes state should be a child of the node that
   creates it — it inherits the state to observe, no extra setup.

3. **State dependency drives hierarchy.**
   If B needs A's state, B is a child of A.
   Siblings are independent — each starts from parent's committed
   state. This minimizes repeated precondition setup.

4. **Isolate broken/error cases.**
   Put invalid specs in a separate subtree so they don't pollute
   the main validation flow.

## 10. Example: Self-Test Bootstrap Tree

```
bootstrap/
  spec.yaml              init project + install SUT
  validate-fresh/        validate initial state
  add-specs/             copy all spec trees at once
    validate/            validate all specs
    run-all/             run → expect pass + fail + skip
    run-with-trace/      run with trace → show trace
    show-tree/           tree shows all specs
    add-bad-spec/        broken spec (isolated)
      validate-rejects/  validate → error
    add-no-primary/     branches without primary → error
```

## Pitfalls

1. HTTP steps execute inside the container (via `node -e fetch`). They CAN
   access container-local services (e.g., `localhost:PORT`). No `network: host`
   needed.

2. Env vars: `$VAR` in commands/HTTP is substituted by treespec (shell priority).
   The `env` field DECLARES required vars — missing → SKIP, not error.

3. Timeout is per-step. `wait.timeout` is total polling time (can exceed step
   timeout).

4. Directories without `spec.yaml` are assets nodes — fixture data, not part
   of the test tree. The scanner ignores them; they're accessible inside the
   container via the `/app` bind mount. Directory name is arbitrary.

5. A subdirectory with `spec.yaml` that is not declared in the parent's
   `primary`/`branches` triggers a warning. Declare all child test nodes
   explicitly.
