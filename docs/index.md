treespec docs — scenario-based documentation

Usage: treespec docs [scenario] [options]
       treespec docs <scenario> --list    # list section titles only
       treespec docs <scenario> -s <n>   # print section n only

Scenarios:

  writing-tests        Writing test cases — spec.yaml, step types, asserts,
                       wait, postcon, tree design, examples

  running-tests        Running tests — config, docker, paths, globs,
                       trace output, LLM assertions setup

  diagnosing-failures  Diagnosing failures — reading traces, jq queries,
                       lineage, common failure patterns

Each scenario is a single document with numbered sections (## headings).
Use --list to see section titles, -s <n> to print a specific section.
