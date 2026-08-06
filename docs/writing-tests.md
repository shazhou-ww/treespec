# Writing Test Cases

How to write treespec test cases: spec.yaml format, step types, assertions,
wait, postcon, tree design principles, and worked examples.

## 1. Test Tree Structure

The directory tree IS the test tree. Each folder with a `spec.yaml` is a test
node. Directories without `spec.yaml` are organizational (pass-through).

```
spec/                         # specs root (configurable in treespec.yaml)
├── provider-add/              #   folder = node name
│   ├── spec.yaml             #   has spec.yaml → test node
│   ├── assets/               #   reserved: mounted via /specs, skipped by scanner
│   │   └── config.json       #   fixture data accessible to this node + children
│   └── model-add/            #   child node (inherits committed state)
│       └── spec.yaml
└── standalone-test/
    └── spec.yaml             #   leaf node (no children, no commit)
```

Rules:
- Has spec.yaml → test node (executes steps, may commit)
- No spec.yaml + has subdirs → organizational node (pass-through, no exec/commit)
- No spec.yaml + no subdirs → ERROR
- Directory name = node name (verb phrase recommended)
- `assets/` is always skipped by the scanner — even if it contains spec.yaml

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

## 7. Docker Commit Chain (State Isolation Model)

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

## 8. Tree Design Principles

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

## 9. Example: Self-Test Bootstrap Tree

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

4. Organizational nodes (no spec.yaml) pass through parent's tag unchanged.
   They don't execute or commit — just a grouping mechanism.

5. `assets/` is ALWAYS skipped, even if it contains spec.yaml files.
   Don't put active test specs in `assets/` — they're fixture data.
