### Eurydice web - AI Agent Guidelines

#### Overview
This document defines the workflow for AI coding agents working on lyra.

#### Tool Stack
- **sequential-thinking**: Planning and analysis
- **mcp-tasks**: Task management in @docs/tasks.md
- **doc-server**: Documentation indexing
- **bash_tool**: Running commands (tests, linters, builds)
- **web_search**: Finding official documentation

---

### Workflow

**Phase 1: Planning with Sequential Thinking**
1. Use sequential-thinking MCP to analyze the request
    - Break down requirements into concrete steps
    - Identify dependencies and potential blockers
    - Consider edge cases and error scenarios
2. Document the plan in @docs/tasks.md using mcp-tasks
    - Create granular, actionable tasks
    - Assign priority levels
    - Note any assumptions or open questions

**Phase 2: Implementation (Plan-Code-Test-Reflect)**
Follow the PCTR cycle for each task:

* **Plan**: Review the current task and its acceptance criteria
* **Code**: Implement the minimal solution
    - Write clean, readable code
    - Add inline comments for complex logic
    - Follow project conventions in pyproject.toml
* **Test**: Verify the implementation
    - Run relevant unit tests
    - Test edge cases manually if needed
    - Check for regressions
* **Reflect**: Evaluate the outcome
    - Did it solve the problem completely?
    - Are there code smells or technical debt?
    - Update task status in @docs/tasks.md
    - If issues are found, return to Plan phase

**Phase 3: Dependency & Documentation Management**

* **Never downgrade dependencies** without explicit approval
* When encountering errors with external libraries:
    1. Search for official documentation using web_search
    2. Index docs with doc-server MCP and wait for completion
    3. Search indexed docs for correct usage patterns
    4. Implement using current dependency versions
    5. If a version conflict is unavoidable, document it in the task and ask for guidance

* **Update documentation** as you code:
    - Keep docstrings current
    - Update README.md for new features
    - Add examples for non-obvious usage

**Phase 4: Quality Gates & Completion**

Before marking a task complete, run these commands in order:

1. **Linting**: `uv run ruff check .`
    - Must return exit code 0 (no errors)
    - If errors found, run `uv run ruff check . --fix` to auto-fix when possible

2. **Formatting**: `uv run ruff format --check --diff .`
    - Must show no diffs (output should be empty)
    - If diffs shown, run `uv run ruff format .` to apply formatting

3. **Tests**: `pytest`
    - All tests must pass
    - If failures occur, analyze and fix before proceeding

4. **Review**: Verify changes against task acceptance criteria
    - Does the implementation match the plan?
    - Are edge cases handled?
    - Is documentation updated?

5. **Update task** in @docs/tasks.md with:
    - What was implemented
    - What was learned
    - Any follow-up tasks needed
    - Mark status as complete

---

### Operational Guidelines

#### Error Recovery Protocol

When encountering errors during implementation:

1. **Capture the full error message** (stack trace, line numbers)
2. **Use sequential-thinking** to analyze the root cause
3. **Search documentation** if library-related (follow Phase 3 process)
4. **Update task** with error details and attempted solutions
5. **Try an alternative approach** if the first attempt fails
6. **Ask for human guidance** if blocked after 2-3 failed attempts

**Do NOT:**
- Randomly try different approaches without analysis
- Downgrade dependencies to "fix" version conflicts
- Skip test failures and mark tasks complete
- Ignore linter warnings

#### Tool Usage Priority

Use tools in this order for each task:

1. **sequential-thinking**: Before starting any task (planning phase)
2. **mcp-tasks**: Immediately after planning (create/update tasks)
3. **web_search + doc-server**: When encountering unknown APIs/errors
4. **bash_tool**: For running tests, linters, building
5. **file operations**: For implementing code changes
6. **mcp-tasks**: After each PCTR cycle (update status and reflections)

#### State Management

Always maintain context by:
- Updating @docs/tasks.md after each PCTR cycle
- Adding reflection notes to tasks (not just completion status)
- Documenting assumptions and decisions in task descriptions
- Noting which documentation was consulted for each solution
- Recording error patterns and their solutions

This enables resuming work if the conversation is interrupted.

#### Scope Control

- Complete ONE task fully before starting another
- If a task reveals new requirements, create a NEW task rather than expanding scope
- Mark tasks as "blocked" if waiting on external dependencies or human input
- Use sequential-thinking to validate if the current approach aligns with the original plan
- When multiple tasks are related, complete them in dependency order


# Notes on implementation: 
if you are using python use uv and pyproject.toml with python 3.12