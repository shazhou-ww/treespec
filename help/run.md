treespec run — execute the test tree

Usage: treespec run [paths...] [options]

Paths: optional positional args (node paths or globs). If omitted, runs all.
  treespec run                    # run entire tree
  treespec run provider-add      # run subtree (auto-pulls ancestors)
  treespec run "provider-*"      # glob match

Options:
  --config <path>       Override treespec.yaml path
  --image <tag>         Use existing image as base (skip build)
  --rebuild             Force rebuild (requires image.dockerfile in config)
  --env-file <path>     Override .env path
  --output <path>       Override output path (dir or .jsonl file)
                         Dir: trace-<timestamp>.jsonl inside
                         File: used directly (no timestamp)
  --no-trace            Skip writing trace JSONL
  --no-mount            Specs already in image (skip bind mount, for DinD)
  --keep-tags           Keep ephemeral image tags after run
  --verbose, -v         Show full step output in terminal
  -h, --help            Show this help

═══════════════════════════════════════════════════════════════

Test tree structure:

  tests/                         # specs root (configurable)
  ├── provider-add/              #   folder = node name
  │   ├── spec.yaml             #   has spec.yaml → test node
  │   ├── assets/               #   reserved: mounted via /specs, skipped by scanner
  │   │   └── config.json       #   fixture data accessible to this node + children
  │   └── model-add/            #   child node (inherits committed state)
  │       └── spec.yaml
  └── standalone-test/
      └── spec.yaml             #   leaf node (no children, no commit)

Rules:
  - Has spec.yaml → test node (executes steps, may commit)
  - No spec.yaml + has subdirs → organizational node (pass-through, no exec/commit)
  - No spec.yaml + no subdirs → ERROR
  - Directory name = node name (verb phrase recommended)
  - assets/ is always skipped by the scanner

═══════════════════════════════════════════════════════════════

spec.yaml format:

  description: "what this test verifies"   # optional but recommended
  env:                                       # optional, required env vars
    - API_KEY                                #   missing → SKIP this node + children
  steps:                                     # required
    - type: exec                             #   exec | http
      command: "some command"                #   required for exec
      timeout: "30s"                         #   optional, per-step
      wait:                                  #   optional — poll until ready
        timeout: "30s"                       #     total wait timeout
        delay: "2s"                          #     gap AFTER step, before re-check
      assert:                                #   optional — omit for transition step
        type: regex                          #   regex | jsonata | llm
        conditions: [...]                    #   (see assert types below)
  postcon:                                   # optional, post-condition verification
    - name: verify-state
      steps: [...]                           #   same Step[] format, runs in fresh container

═══════════════════════════════════════════════════════════════

Step types:

  type: exec — Run a shell command inside the container.
    - type: exec
      command: "echo hello"
      timeout: "10s"
      assert: { type: regex, ... }

  type: http — Send an HTTP request from the HOST (not inside container).
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

  HTTP steps support $VAR and ${VAR} env substitution in url, headers, body.

═══════════════════════════════════════════════════════════════

Assertion types:

  type: regex — Match patterns against step output paths.
    assert:
      type: regex
      conditions:
        - { path: "stdout", regex: "hello" }
        - { path: "exit_code", regex: "^0$" }
    Paths: stdout | stderr | exit_code (exec) | status | body | headers.* (http)
    All conditions must match → PASS. Any miss → FAIL.

  type: jsonata — JSONata expression evaluated against a context object.
    assert:
      type: jsonata
      expression: "status = 200 and json.hello = 'world'"
    Context for exec: { stdout, stderr, exit_code } (stdout parsed as JSON if possible)
    Context for http: { status, body, headers, json } (body parsed as JSON if possible)
    Truthy result → PASS.

  type: llm — LLM reads step output + judge prompt, returns verdict.
    assert:
      type: llm
      prompt: "Does the output contain the word hello?"
    Requires TREESPEC_LLM_BASE_URL, TREESPEC_LLM_MODEL, TREESPEC_LLM_API_KEY env vars.
    LLM receives: test description + step history + current step output + prompt.
    Returns VERDICT: PASS or VERDICT: FAIL + REASON: <explanation>.
    temperature=0, max_tokens=256.

  (omit assert) — Transition step. Exit 0 = PASS, non-zero = FAIL.

Decision guide:
  Pattern matching on output?      → regex
  Extract/validate structured data? → jsonata
  Need semantic judgment?           → llm
  Just cd/mkdir/setup?              → omit assert

═══════════════════════════════════════════════════════════════

wait (polling for async operations):

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

  Semantics: "not ready yet, wait and re-check" — NOT "failed, retry".
  Step re-executes until assert passes or timeout. Only PASS/FAIL (no RETRY).

═══════════════════════════════════════════════════════════════

postcon (post-condition verification):

  postcon:
    - name: verify-state-committed
      steps:
        - type: exec
          command: "cat /tmp/state"
          assert: { type: regex, ... }

  Runs in a FRESH container from the committed image (after steps complete).
  Use case: verify that state was persisted via docker commit.
  postcon container is isolated — mutations don't affect the committed image.
  Multiple postcons run serially (peak: 1 mutator + 1 probe container).
  postcon failure → same as step failure: prune children.

═══════════════════════════════════════════════════════════════

docker commit chain:

  Parent node executes steps → docker commit → new image tag.
  Child node starts a container FROM that tag → sees parent's state.
  DFS traversal: only current path's tags exist (O(depth) disk).

  writes-state/           # echo data > /tmp/state → commit
    reads-state/          # cat /tmp/state (sees parent's data) → commit
      reads-deep/         # still sees ancestor's data

  Leaf nodes (no children, no postcon) → no commit (just execute + assert).

═══════════════════════════════════════════════════════════════

Failure pruning:

  Any assertion failure (step or postcon) → node FAIL → entire subtree pruned.
  Children show as SKIP. This prevents testing on untrusted state.

  Example:
    fails-on-purpose/          # exit 1 → FAIL
      should-be-skipped/       # SKIP (parent failed, state untrustworthy)

═══════════════════════════════════════════════════════════════

assets/ directory:

  Reserved name. Scanner skips it. Files are accessible via mount at /specs.
  Use for fixture data, config files, expected outputs.

  tests/
    my-test/
      spec.yaml
      assets/
        config.json      # accessible at /specs/my-test/assets/config.json
        expected.txt

═══════════════════════════════════════════════════════════════

Trace output (JSONL, written to output path):

  Default: .treespec-output/<name>-<timestamp>.jsonl (non-overwriting)
  --output <dir>       → <dir>/<name>-<timestamp>.jsonl
  --output file.jsonl  → file.jsonl (exact, no timestamp)

  <name> comes from treespec.yaml name field, or directory basename if unset.

  Line types: meta | step | summary
  meta:   { type, started_at, total_nodes, base_image }
  step:   { type, node_path, step_index, command, stdout, stderr, exit_code, verdict, reason, duration_ms }
  summary: { type, total, passed, failed, skipped, duration_ms, ended_at }

  Use --no-trace to skip. Use --output <path> to override location.

═══════════════════════════════════════════════════════════════

Pitfalls:

1. HTTP steps run on HOST, not inside container. They can't access
   container-local files. Use exec steps for container-internal checks.

2. Env vars: $VAR in commands/HTTP is substituted by treespec (shell priority).
   The `env` field DECLARES required vars — missing → SKIP, not error.

3. --image overrides image.dockerfile in config. --rebuild requires dockerfile.
   Don't use --rebuild with --image.

4. --no-mount is for Docker-in-Docker (specs baked into image via COPY).
   Use when running treespec inside a container that has Docker socket access.

5. Timeout is per-step. wait.timeout is total polling time (can exceed step timeout).

6. Organizational nodes (no spec.yaml) pass through parent's tag unchanged.
   They don't execute or commit — just a grouping mechanism.

7. assets/ is ALWAYS skipped, even if it contains spec.yaml files.
   Don't put active test specs in assets/ — they're fixture data.