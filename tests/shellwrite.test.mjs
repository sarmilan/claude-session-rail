import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWritePath, shellWrites } from '../bin/shellwrite.mjs';

const writes = (command) => shellWrites(command);
const isWrite = (command) => writes(command) !== null;

test('read-only commands are not writes', () => {
  for (const command of [
    'git log',
    'git status',
    'git diff',
    'git show HEAD',
    'ls',
    'ls -la src',
    'cat src/a.ts',
    'echo hello',
    'echo "cat > src/a.ts"',
    "echo 'hello > world'",
    'pwd',
    'npm test',
    'npm run test',
    'node bin/desk.mjs --frame 72 24 --tab plan',
    'node --test tests/shellwrite.test.mjs',
    'git add -A',
    'git commit -m "x"',
    'git commit -m "feat: cat > file"',
    'git push',
    'git checkout -b feature/x',
    'git switch -c feature/x',
    'git apply --check patch.diff',
    'git clean -n',
    'git stash list',
    'git restore --staged src/a.ts',
    'git reset HEAD src/a.ts',
    'echo hi > /dev/null',
    'git log > /dev/null',
    'npm test > /dev/null 2>&1',
    'sed "s/a/b/" src/a.ts',
    'vim --version',
    'make test',
    'make -n',
    'cat file',
    'head -n 5 README.md',
    'gh pr view',
  ]) {
    assert.equal(isWrite(command), false, command);
  }
});

test('a heredoc body is data, not a command', () => {
  assert.equal(isWrite('cat <<EOF\necho hi > src/a.ts\nEOF'), false);
  assert.equal(isWrite("cat <<'EOF'\nrm src/a.ts\nEOF"), false);
});

test('redirects, tee, copy, and editors name the file they write', () => {
  assert.deepEqual(writes('cat > src/a.ts'), ['src/a.ts']);
  assert.deepEqual(writes('cat>src/a.ts'), ['src/a.ts']);
  assert.deepEqual(writes('echo hi >> src/a.ts'), ['src/a.ts']);
  assert.deepEqual(writes('echo hi > "my file.ts"'), ['my file.ts']);
  assert.ok(writes('tee src/a.ts').includes('src/a.ts'));
  assert.ok(writes('tee -a src/a.ts').includes('src/a.ts'));
  assert.ok(writes('cp /tmp/x src/a.ts').includes('src/a.ts'));
  assert.ok(writes('mv a.ts b.ts').includes('b.ts'));
  assert.deepEqual(writes('rm src/a.ts'), ['src/a.ts']);
  assert.ok(writes('rm -rf src').includes('src'));
  assert.ok(writes("sed -i 's/a/b/' src/a.ts").includes('src/a.ts'));
  assert.equal(isWrite("sed 's/a/b/' src/a.ts"), false);
  assert.deepEqual(writes('vim src/a.ts'), ['src/a.ts']);
  assert.deepEqual(writes('mkdir -p src/new'), ['src/new']);
  assert.ok(writes('dd of=src/a.ts').includes('src/a.ts'));
  assert.ok(writes('curl -o src/a.ts https://example.com').includes('src/a.ts'));
  assert.deepEqual(writes('git checkout -- src/a.ts'), ['src/a.ts']);
  assert.deepEqual(writes('git checkout HEAD -- src/a.ts'), ['src/a.ts']);
  assert.ok(writes('git apply patch.diff'));
  assert.ok(writes('git reset --hard'));
  assert.ok(writes('git clean -fd'));
  assert.ok(writes('git rm src/a.ts').includes('src/a.ts'));
  assert.ok(writes('git mv a.ts b.ts').includes('b.ts'));
});

test('a redirect in a later segment is still a write, and a quoted one is not', () => {
  assert.deepEqual(writes('git log && cat > src/a.ts'), ['src/a.ts']);
  assert.deepEqual(writes('git status; tee src/a.ts'), ['src/a.ts']);
  assert.ok(writes('echo hi | tee src/a.ts').includes('src/a.ts'));
  assert.equal(isWrite('echo "then cat > src/a.ts"'), false);
  assert.deepEqual(writes('cat > src/a.ts <<EOF\nhello\nEOF'), ['src/a.ts']);
  assert.deepEqual(writes("sh -c 'cat > src/a.ts'"), ['src/a.ts']);
  assert.deepEqual(writes('bash -lc "echo hi > src/a.ts"'), ['src/a.ts']);
  assert.equal(isWrite("sh -c 'git log'"), false);
});

test('a variable or a glob is a write with no literal path', () => {
  assert.deepEqual(writes('cat > "$FILE"'), [null]);
  assert.deepEqual(writes('rm *.ts'), [null]);
  assert.deepEqual(writes('echo hi > ~/notes'), [null]);
  assert.ok(writes('git apply /tmp/p.diff'));
  assert.deepEqual(writes('git checkout main'), [null]);
});

test('the brief path and an outside path stay literal so the gate can tell them apart', () => {
  const brief = '/repo/.git/session-rail/briefs/feature%2Fx.md';
  const approval = '/repo/.git/session-rail/briefs/feature%2Fx.approved.json';
  assert.deepEqual(writes(`cat > ${brief}`), [brief]);
  assert.deepEqual(writes(`echo '{}' > ${approval}`), [approval]);
  assert.deepEqual(writes('echo hi > /tmp/plan.md'), ['/tmp/plan.md']);
  assert.equal(resolveWritePath('/repo', 'src/a.ts'), '/repo/src/a.ts');
  assert.equal(resolveWritePath('/repo/packages/app', 'src/a.ts'), '/repo/packages/app/src/a.ts');
  assert.equal(resolveWritePath('/repo', '/tmp/plan.md'), '/tmp/plan.md');
  assert.equal(resolveWritePath('/repo', '.git/session-rail/briefs/x.md'), '/repo/.git/session-rail/briefs/x.md');
  assert.equal(resolveWritePath('/repo', '../etc/passwd'), '/etc/passwd');
});

test('in-place interpreters and package installs write; a print does not', () => {
  assert.ok(writes('perl -pi -e "s/a/b/" src/a.ts').includes('src/a.ts'));
  assert.deepEqual(writes(`python -c "open('src/a.ts','w').write('x')"`), ['src/a.ts']);
  assert.equal(isWrite('node -e "console.log(1)"'), false);
  assert.equal(isWrite('python -c "open(\'src/a.ts\').read()"'), false);
  assert.ok(writes('npm install'));
  assert.ok(writes('yarn'));
  assert.equal(isWrite('yarn test'), false);
  assert.ok(writes('find src -delete'));
  assert.equal(isWrite('find src -name "*.ts"'), false);
  assert.ok(writes('xargs rm'));
  assert.equal(isWrite('xargs grep foo'), false);
});
