# Decision: Git Safety Rules for All Agents (Issue #86)

**By:** Verbal  
**Date:** 2026-02-20  
**Issue:** #86 — Squad undid its own uncommitted changes from a previous session

## Problem

An agent used `git checkout` (or equivalent) to undo its own in-progress work. This also wiped
uncommitted changes from a prior session that had not been committed. The agent recovered (had
context), but the silent data loss should not happen in the first place.

**Root cause:** No rule prevented agents from running destructive git operations on files they
did not touch. No pre-op check for foreign uncommitted changes existed.

## Decision

All agents (via the spawn template) must follow these rules before any destructive git operation
(`git checkout --`, `git restore`, `git reset --hard`, `git clean -f`):

1. **Check first:** Run `git status --porcelain`. Non-empty output = uncommitted changes exist.
2. **Own your changes:** Only discard files you modified in the current agent turn. Never touch
   files you did not create or modify in this session.
3. **If foreign changes exist — stop:** Write a conflict drop file to
   `.squad/decisions/inbox/{name}-git-safety-{timestamp}.md` and surface the issue to the user.
   Do not proceed until the user commits, stashes, or explicitly approves the destructive op.

## Changes Made

- `.github/agents/squad.agent.md` — Added `### Git Safety — Protecting Uncommitted Work` section
  (new standalone section after anti-patterns). Added `⚠️ GIT SAFETY` block to both the standard
  and lightweight spawn templates so ALL spawned agents inherit the rule.
- `.ai-team/agents/fenster/charter.md` — Added `## Git Safety` section. Fenster (core dev, owns
  git ops) carries the authoritative version of this rule.

## Regression Test

`test/git-safety.test.js` (added by Hockney in same branch, commit fcfdf3a) anchors the rule:
- Suite 1: verifies `git status --porcelain` correctly detects uncommitted files.
- Suite 2: verifies `create-squad` init emits no destructive git commands.
