#!/usr/bin/env node
// Post the branch's review record where a teammate can see it: a commit status named session-rail/review,
// and one pull request comment kept up to date. The status is not required. Branch protection can require
// the context; until then a person can merge, and git merge is not blocked.
//
//   node publish.mjs [--cwd DIR]     post the saved record for HEAD (exits 0; the review is already saved)
//   node publish.mjs --require       exit 1 unless HEAD's session-rail/review status is success
//
// SESSION_RAIL_PUBLISH=0 leaves the record in .git and posts nothing. success is posted only by
// reviewstatus.mjs, and only when the saved record passes the merge gate.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { headCommit, reviewsPath } from './sources.mjs';
import {
  COMMENT_MARKER, commentBody, commitSha, openTitles, repoSlug, requireVerdict, reviewStatus, statusRequest,
} from './reviewstatus.mjs';

// spawn, not execFile: an empty `input` is falsy, and execFile then leaves stdin open. `gh` reading
// stdin (and a test double that does) would wait until the timeout.
const ghExec = (args, { cwd, input, timeout = 12_000 } = {}) => new Promise((resolve) => {
  let out = '', settled = false, timer;
  const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok, out }); };
  const child = spawn('gh', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  timer = setTimeout(() => { child.kill(); done(false); }, timeout);
  child.stdout.on('data', (d) => { if (out.length < (4 << 20)) out += d; });
  child.stdout.on('error', () => {});
  child.stdin.on('error', () => {});
  child.on('error', () => done(false));
  child.on('close', (code) => done(code === 0));
  try { child.stdin.end(input ?? ''); } catch { done(false); }
});

async function readRuns(cwd) {
  const path = await reviewsPath(cwd);
  if (!path) return [];
  try {
    const runs = JSON.parse(await readFile(path, 'utf8'))?.runs;
    return Array.isArray(runs) ? runs.filter((r) => r && Array.isArray(r.findings)) : [];
  } catch { return []; }
}

/**
 * Post `runs` for `head`. `gh` is `(args, { cwd, input }) => { ok, out }`, so tests never call GitHub.
 * A missing repo, a head that is not a full commit, or a refused request posts nothing and returns
 * published: false. It never turns a failure into success.
 */
export async function publishReview({ runs, head, cwd, gh = ghExec, env = process.env } = {}) {
  const status = reviewStatus(runs, { head });
  if (env.SESSION_RAIL_PUBLISH === '0') return { published: false, comment: false, status, reason: 'publishing is off' };
  const repoOut = await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd });
  const repo = repoSlug(repoOut.ok ? repoOut.out : '');
  const sha = commitSha(status.head);
  if (!repo) return { published: false, comment: false, status, reason: 'no GitHub repo' };
  if (!sha) return { published: false, comment: false, status, reason: 'no commit' };
  let pr = null;
  const prOut = await gh(['pr', 'view', '--json', 'number,url,state,headRefOid'], { cwd });
  if (prOut.ok) { try { pr = JSON.parse(prOut.out); } catch { pr = null; } }
  const number = Number.isInteger(pr?.number) && pr.number > 0 ? pr.number : null;
  const url = typeof pr?.url === 'string' ? pr.url : undefined;
  const posted = await gh(
    ['api', '--method', 'POST', '--input', '-', `repos/${repo}/statuses/${sha}`],
    { cwd, input: JSON.stringify(statusRequest(status, { targetUrl: url })) },
  );
  if (!posted.ok) return { published: false, comment: false, status, reason: 'GitHub did not accept the status' };
  let comment = false;
  if (number) {
    const listed = await gh(
      ['api', '--paginate', `repos/${repo}/issues/${number}/comments`, '--jq', `.[] | select(.body | contains(${JSON.stringify(COMMENT_MARKER)})) | .id`],
      { cwd },
    );
    const ids = listed.ok ? listed.out.split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)) : [];
    const payload = JSON.stringify({ body: commentBody(status, { findings: openTitles(runs) }) });
    const endpoint = ids.length ? `repos/${repo}/issues/comments/${ids[0]}` : `repos/${repo}/issues/${number}/comments`;
    const method = ids.length ? 'PATCH' : 'POST';
    const wrote = await gh(['api', '--method', method, '--input', '-', endpoint], { cwd, input: payload });
    comment = wrote.ok;
  }
  return { published: true, comment, status, url: url ?? null, reason: null };
}

/** Read the commit's statuses. Success only when session-rail/review is already success. This does not post one. */
export async function requireReview({ cwd, gh = ghExec, sha, repo } = {}) {
  const slug = repoSlug(repo ?? (await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd })).out);
  const commit = commitSha(sha ?? await headCommit(cwd));
  if (!slug || !commit) return { ok: false, state: 'missing' };
  const res = await gh(['api', `repos/${slug}/commits/${commit}/statuses`], { cwd });
  if (!res.ok) return { ok: false, state: 'missing' };
  try { return requireVerdict(JSON.parse(res.out)); } catch { return { ok: false, state: 'missing' }; }
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) {
  const at = process.argv.indexOf('--cwd');
  const cwd = at > 0 ? process.argv[at + 1] : process.cwd();
  if (process.argv.includes('--require')) {
    const verdict = await requireReview({ cwd });
    process.stderr.write(`session-rail/review: ${verdict.state}\n`);
    if (!verdict.ok) process.stderr.write('A passing review is posted only when the saved record is clean. This command does not create one.\n');
    process.exit(verdict.ok ? 0 : 1);
  }
  const [runs, head] = await Promise.all([readRuns(cwd), headCommit(cwd)]);
  const result = await publishReview({ cwd, runs, head });
  process.stdout.write(`${JSON.stringify({
    published: result.published, comment: result.comment, state: result.status.state,
    context: result.status.context, description: result.status.description, reason: result.reason,
  })}\n`);
}
