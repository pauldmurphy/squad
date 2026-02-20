/**
 * git-safety.test.js — Regression tests for #86
 *
 * Guards against agents using destructive git commands (git checkout, git restore)
 * that wipe uncommitted work from prior sessions.
 *
 * Since we can't spawn a real agent in tests, we anchor the regression on two
 * detectable preconditions:
 *   1. `git status --porcelain` correctly reports uncommitted files — this is
 *      the check agents are now required to run before any destructive op.
 *   2. The create-squad CLI (index.js) does NOT emit destructive git commands
 *      during init — agents should never see `git checkout` or `git restore`
 *      in their scaffolding output.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const os = require('os');

const CLI = path.join(__dirname, '..', 'index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `squad-git-safety-${prefix}-`));
}

function cleanDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Create a minimal git repo with one committed file so HEAD exists. */
function initGitRepo(dir) {
  runGit(['init', '-b', 'main'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Test'], dir);
  const seedFile = path.join(dir, 'README.md');
  fs.writeFileSync(seedFile, '# test repo\n');
  runGit(['add', 'README.md'], dir);
  runGit(['commit', '-m', 'initial commit'], dir);
}

function runSquad(args, cwd) {
  try {
    const result = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return {
      stdout: (err.stdout || '') + (err.stderr || ''),
      exitCode: err.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Suite 1 — git status --porcelain detects uncommitted changes (#86)
// ---------------------------------------------------------------------------

describe('git status --porcelain detects uncommitted changes (#86)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir('status');
    initGitRepo(tmpDir);
  });

  afterEach(() => cleanDir(tmpDir));

  it('git status --porcelain is empty on a clean repo', () => {
    const status = runGit(['status', '--porcelain'], tmpDir).trim();
    assert.equal(status, '', 'clean repo should have empty porcelain status');
  });

  it('git status --porcelain reports an untracked file', () => {
    // Simulate prior-agent work: an uncommitted file left behind
    fs.writeFileSync(path.join(tmpDir, 'agent-work.js'), 'console.log("work in progress");\n');

    const status = runGit(['status', '--porcelain'], tmpDir).trim();
    assert.ok(status.length > 0, 'porcelain status should be non-empty when uncommitted files exist');
    assert.ok(status.includes('agent-work.js'), 'porcelain status should list the uncommitted file');
  });

  it('git status --porcelain reports a modified tracked file', () => {
    // Modify the already-committed README (tracked but dirty)
    fs.appendFileSync(path.join(tmpDir, 'README.md'), '\n## Added by agent\n');

    const status = runGit(['status', '--porcelain'], tmpDir).trim();
    assert.ok(status.length > 0, 'porcelain status should be non-empty after modifying a tracked file');
    assert.ok(status.includes('README.md'), 'porcelain status should list the modified file');
  });

  it('uncommitted file survives a safe operation (no destructive git cmd)', () => {
    // Simulates the "recovery" scenario: agent detects dirty state via
    // git status --porcelain, logs it, and does NOT run git checkout/restore.
    // The uncommitted file must still be present afterwards.
    const priorWork = path.join(tmpDir, 'frontend-work.ts');
    fs.writeFileSync(priorWork, 'export const x = 1;\n');

    // Confirm the file is detected as uncommitted
    const statusBefore = runGit(['status', '--porcelain'], tmpDir).trim();
    assert.ok(statusBefore.includes('frontend-work.ts'), 'uncommitted file detected before recovery');

    // Simulate safe agent recovery: stash list, log status — no git checkout/restore
    runGit(['stash', 'list'], tmpDir);        // read-only
    runGit(['status', '--porcelain'], tmpDir); // read-only

    // The file must still be present (no destructive cmd was run)
    assert.ok(fs.existsSync(priorWork), 'uncommitted file must survive safe agent recovery');

    const statusAfter = runGit(['status', '--porcelain'], tmpDir).trim();
    assert.ok(statusAfter.includes('frontend-work.ts'), 'uncommitted file still detected after recovery');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — create-squad CLI init emits no destructive git commands (#86)
// ---------------------------------------------------------------------------

describe('create-squad CLI init does not emit destructive git commands (#86)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir('cli');
    initGitRepo(tmpDir);
  });

  afterEach(() => cleanDir(tmpDir));

  it('init output does not contain "git checkout"', () => {
    const { stdout } = runSquad([], tmpDir);
    assert.ok(
      !stdout.includes('git checkout'),
      `CLI init must not emit "git checkout" — output was:\n${stdout}`
    );
  });

  it('init output does not contain "git restore"', () => {
    const { stdout } = runSquad([], tmpDir);
    assert.ok(
      !stdout.includes('git restore'),
      `CLI init must not emit "git restore" — output was:\n${stdout}`
    );
  });

  it('init output does not contain "git clean -f"', () => {
    const { stdout } = runSquad([], tmpDir);
    assert.ok(
      !stdout.includes('git clean -f'),
      `CLI init must not emit "git clean -f" — output was:\n${stdout}`
    );
  });

  it('uncommitted file in target repo survives create-squad init', () => {
    // Place an uncommitted file in the repo — it must not be wiped by init
    const priorWork = path.join(tmpDir, 'my-feature.ts');
    fs.writeFileSync(priorWork, 'export const feature = true;\n');

    const statusBefore = runGit(['status', '--porcelain'], tmpDir).trim();
    assert.ok(statusBefore.includes('my-feature.ts'), 'uncommitted file exists before init');

    runSquad([], tmpDir);

    assert.ok(fs.existsSync(priorWork), 'uncommitted file must still exist after create-squad init');

    const statusAfter = runGit(['status', '--porcelain'], tmpDir).trim();
    assert.ok(statusAfter.includes('my-feature.ts'), 'uncommitted file still detected after init');
  });
});
