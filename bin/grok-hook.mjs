#!/usr/bin/env node
// Grok's side of the session rail. One command hook for every event: Grok writes the event as JSON on
// stdin and this process exits. Interactive `grok` only (a headless `grok -p` has no TTY and must not
// open panes or gate an outer session). The Claude plugin stays in hooks/register.ts.
//
// It opens the desk and the rail, keeps the Now feed, refuses code edits and a shell command that writes
// a file until the brief is approved, refuses `gh pr merge` until the reviews are in, and records a
// /review report. The go-ahead and auto-compact run in grok-watch.mjs, because a hook can't type into
// the session on its own.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as act from './activity.mjs';
import { humanAsk, keep } from './sessionstory.mjs';
import { briefInstructions, outsideRepoNote } from './brief-instructions.mjs';
import { approvalRecord, briefFile, briefStatus, checkoutName, inWorkTree, mainCheckoutNote, NO_BRIEF_BRANCHES, parseBrief } from './brief.mjs';
import { codeRun, gateReason as reviewWait, keptRuns, mergesPr, reportFromText, reviewsFile } from './cadence.mjs';
import { resolveWritePath, shellWrites } from './shellwrite.mjs';
import { findAgent, railHome } from './host.mjs';
import { pickColour, pickName } from './names.mjs';
import { activityNames } from './prune.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RAIL = railHome();
const EDIT = new Set(['search_replace', 'write', 'StrReplace', 'Edit', 'Write', 'NotebookEdit', 'EditNotebook']);
const SPAWN_TOOLS = new Set(['spawn_subagent', 'Agent', 'Task']);
const SHELL = new Set(['run_terminal_command', 'Bash']);

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, p);
};
const git = (cwd, args) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; }
};

function rebaseRef(dir) {
  if (!dir) return '';
  for (const name of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
    try { return readFileSync(join(dir, name), 'utf8').trim(); } catch { /* not this rebase */ }
  }
  return '';
}

export function gitHead(cwd) {
  const out = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--abbrev-ref', 'HEAD']);
  if (!out) return null;
  const [common, abbrev] = out.split('\n');
  if (!common || !abbrev) return null;
  const branch = abbrev === 'HEAD'
    ? checkoutName(abbrev, rebaseRef(git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir'])))
    : abbrev;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const root = top && top.startsWith('/') ? top : cwd;
  return { cwd, common, branch, root };
}

export function readBrief(cwd) {
  const head = gitHead(cwd);
  if (!head || NO_BRIEF_BRANCHES.includes(head.branch)) return null;
  const path = briefFile(head.common, head.branch, 'md');
  const approvedPath = briefFile(head.common, head.branch, 'approved.json');
  return {
    branch: head.branch, common: head.common, path, approvedPath, dir: `${head.common}/session-rail/`,
    text: existsSync(path) ? readFileSync(path, 'utf8') : null, approval: readJson(approvedPath),
  };
}

// Why an edit of `file` (absolute, or relative to the checkout) is refused, or null to let it through.
// `checkout` is `{ branch, cwd }` when this checkout cannot hold a brief. A path outside `cwd` is not a repo edit.
export function editReason(b, file, checkout) {
  if (!b) {
    const branch = checkout?.branch;
    if (!branch || !NO_BRIEF_BRANCHES.includes(branch)) return null;
    if (checkout.cwd && !inWorkTree(checkout.cwd, file)) return null;
    return mainCheckoutNote(branch);
  }
  if (file === b.approvedPath) return 'session-rail: only the person approves the brief, in the desk or with /approve-brief.';
  if ((file && file.startsWith(b.dir)) || b.approval?.approvedAt) return null;
  const where = `The brief for ${b.branch} is at ${b.path}. The procedure is in ${join(RAIL, 'grok-brief.md')}.`;
  if (b.text === null) return `session-rail: code edits wait for the session brief. Write it first. ${where}`;
  const brief = parseBrief(b.text);
  if (brief.missing.length) return `session-rail: code edits wait for the session brief, which is missing: ${brief.missing.join(', ')}. ${where}`;
  return `session-rail: the session brief is complete but not approved yet. Ask the person to review it in the desk's Plan tab and press Approve there, then carry on. ${where}`;
}

// A shell write uses the same reason as Edit. `null` from shellWrites is a write with no literal path,
// treated as a file in the checkout so the person runs it themselves. The refusal is the Held banner.
export function shellEdit(cwd, command) {
  const targets = shellWrites(command);
  if (!targets) return null;
  const b = readBrief(cwd);
  const head = gitHead(cwd);
  const root = head?.root || head?.cwd || cwd;
  const base = head?.cwd || cwd;
  const checkout = !b && head && NO_BRIEF_BRANCHES.includes(head.branch)
    ? { branch: head.branch, cwd: head.root || head.cwd } : null;
  for (const target of targets) {
    const file = target == null ? `${root}/shell-write` : resolveWritePath(base, target);
    if (!file) continue;
    const reason = editReason(b, file, checkout);
    if (reason) return { reason, file };
  }
  return null;
}

export function slashCommand(text) {
  const t = String(text ?? '');
  return t.trim().match(/^\/(?:[\w.-]+:)?(rail|desk|approve-brief)\b/)?.[1]
    || t.match(/session-rail-command:\s*(rail|desk|approve-brief)/)?.[1]
    || null;
}

const kindOf = (e) => {
  const raw = String(e.hook_event_name || e.hookEventName || '').toLowerCase().replace(/_/g, '');
  return {
    sessionstart: 'start', sessionend: 'end', userpromptsubmit: 'prompt',
    pretooluse: 'pre', posttooluse: 'post', posttoolusefailure: 'fail',
    stop: 'stop', subagentstop: 'agent-stop', subagentstart: 'agent-start',
    notification: 'note', postcompact: 'compacted',
  }[raw] || '';
};
const sidOf = (e) => e.sessionId || e.session_id || process.env.GROK_SESSION_ID || '';
const promptOf = (e) => {
  const p = e.prompt ?? e.userPrompt ?? e.user_prompt ?? e.message ?? '';
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) return p.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n');
  return '';
};
const toolOf = (e) => e.toolName || e.tool_name || '';
const inputOf = (e) => e.toolInput || e.tool_input || {};
const useOf = (e) => e.toolUseId || e.tool_use_id || '';

const activityFile = (id) => join(RAIL, 'activity', `${id}.json`);
const stateFile = (id) => join(RAIL, 'state', `${id}.json`);
const loadAct = (id) => { const a = id && readJson(activityFile(id)); return a?.claude ? a : act.fresh(Date.now()); };
const saveAct = (id, a) => { if (id) writeJson(activityFile(id), a); };
const loadState = (id) => (id && readJson(stateFile(id))) || {};
const saveState = (id, s) => { if (id) writeJson(stateFile(id), s); };
// The session is gone: drop its activity, desk, and rail-tab files. A clear, compact, or resume keeps them.
const forgetActivity = (id) => {
  const root = join(RAIL, 'activity');
  for (const name of activityNames(id)) {
    try { unlinkSync(join(root, name)); } catch { /* already gone */ }
  }
};

function summarise(tool, input, cwd) {
  const s = (k) => (typeof input?.[k] === 'string' ? input[k] : '');
  const rel = (p) => (cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p);
  const file = s('file_path') || s('path') || s('target_file') || s('notebook_path');
  const arg = SHELL.has(tool) ? s('command')
    : SPAWN_TOOLS.has(tool) ? s('description')
    : file ? rel(file)
    : s('pattern') || s('query') || s('url') || s('description') || s('prompt');
  return arg.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function resultId(result) {
  if (result && typeof result === 'object') {
    return result.subagent_id || result.subagentId || result.agentId || result.agent_id || null;
  }
  const m = String(result ?? '').match(/subagent_id["']?\s*[:=]\s*["']([^"']+)/);
  return m?.[1] || null;
}

function panelMessage(state, panel) {
  const name = panel === 'rail' ? 'Rail' : 'Desk';
  const messages = {
    opened: `${name} opened.`,
    'already-open': `${name} is already open.`,
    closed: `${name} closed.`,
    'already-closed': `${name} is already closed.`,
    'not-iterm': `The ${name.toLowerCase()} only opens when Grok runs in iTerm2.`,
    'no-claude': "Couldn't find this Grok session's terminal.",
  };
  return messages[state] ?? `Couldn't open or close the ${name.toLowerCase()} (is node on your PATH?).`;
}

function runPane(action, panel, sessionId) {
  const args = [join(ROOT, 'bin', 'pane.mjs'), action];
  if (panel) args.push(panel);
  try {
    const out = execFileSync(process.execPath, args, {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, SESSION_RAIL_SESSION: sessionId || '' },
    });
    return JSON.parse(out).state || 'error';
  } catch { return 'error'; }
}

function approve(cwd) {
  const b = readBrief(cwd);
  if (!b) return 'This branch has no session brief (main, master and a detached HEAD go without one).';
  if (b.text === null) return `No brief for ${b.branch} yet. Grok writes it at ${b.path} before editing code.`;
  const brief = parseBrief(b.text);
  if (brief.missing.length) return `Can't approve yet: the brief is missing ${brief.missing.join(', ')}.\n${b.path}`;
  if (briefStatus(brief, b.approval) === 'approved') return `The brief for ${b.branch} is already approved.`;
  mkdirSync(dirname(b.approvedPath), { recursive: true });
  writeFileSync(b.approvedPath, approvalRecord(brief, Date.now()));
  return `Brief approved. Grok can edit code on ${b.branch} and will be told to go ahead in a moment.`;
}

function writeProcedure(b) {
  const text = briefInstructions(b, `node ${join(ROOT, 'bin', 'reviewer.mjs')} --run --host grok`);
  mkdirSync(RAIL, { recursive: true });
  writeFileSync(join(RAIL, 'grok-brief.md'), text);
  return text;
}

/** The next tool call of this turn attaches the procedure. A user prompt and a compaction both arm it. */
export function armTurn(state) {
  state.briefSent = false;
}

/** The procedure text for this turn's first tool call, or null once this turn has already attached it. */
export function takeProcedure(state, text) {
  if (state.briefSent || !text) return null;
  state.briefSent = true;
  return text;
}

// The note for a checkout that cannot hold a brief, or null when this folder is not one of those.
function checkoutNote(cwd) {
  const head = gitHead(cwd);
  if (!head || !NO_BRIEF_BRANCHES.includes(head.branch)) return null;
  return mainCheckoutNote(head.branch);
}

// The brief procedure, on the first tool call of each turn. On main, master, or a detached HEAD the note
// says to branch first. Outside a git checkout it names the folder and says the desk cannot see a brief
// written somewhere else. Null again until the next user prompt.
export function procedure(cwd, state) {
  if (state.briefSent) return null;
  const b = readBrief(cwd);
  if (b) return takeProcedure(state, writeProcedure(b));
  return takeProcedure(state, checkoutNote(cwd) || (!gitHead(cwd) ? outsideRepoNote(cwd) : null));
}

function recordCodeReview(cwd, report) {
  const b = readBrief(cwd);
  if (!b) return;
  const path = reviewsFile(b.common, b.branch);
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const dirty = git(cwd, ['status', '--porcelain']);
  const earlier = (readJson(path)?.runs ?? []).filter((r) => r && Array.isArray(r.findings));
  const runs = [codeRun(report, { head, dirty: dirty == null || dirty !== '', at: Date.now() }), ...earlier];
  writeJson(path, { runs: keptRuns(runs) });
  schedulePublish(cwd);
}

// The review file is already written. Detached, so a slow gh does not hold the hook.
export function schedulePublish(cwd, spawnFn = spawn) {
  try {
    const child = spawnFn(process.execPath, [join(ROOT, 'bin', 'publish.mjs'), '--cwd', cwd], {
      detached: true, stdio: 'ignore',
    });
    child?.unref?.();
    return true;
  } catch { return false; }
}

function startWatch(pid, sessionId, state) {
  if (!sessionId) return;
  if (state.watchPid) { try { process.kill(state.watchPid, 0); return; } catch { /* gone */ } }
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'grok-watch.mjs'), String(pid), sessionId], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
  state.watchPid = child.pid;
}

function modelOf(cwd, id) {
  return readJson(join(homedir(), '.grok', 'sessions', encodeURIComponent(cwd || ''), id, 'summary.json'))?.current_model_id || null;
}

// `agent` is the grok process this event belongs to. Returns a hook reply, or null to say nothing.
export function handle(event, agent) {
  // A headless review (`grok -p`) sets this so it never opens panes on the desk that launched it.
  if (process.env.SESSION_RAIL_HEADLESS) return null;
  if (!agent || agent.host !== 'grok' || !agent.tty) return null;
  const kind = kindOf(event);
  if (!kind) return null;
  const id = sidOf(event);
  const cwd = event.cwd || event.workspaceRoot || process.cwd();
  const now = Date.now();
  let activity = loadAct(id);
  if (Number.isInteger(agent.pid) && agent.pid > 0) activity.pid = agent.pid;
  let state = loadState(id);
  let reply = null;
  const save = () => { saveAct(id, activity); saveState(id, state); };

  if (kind === 'start') {
    writeJson(join(RAIL, 'host.json'), { pluginRoot: ROOT, host: 'grok' });
    const b = readBrief(cwd);
    if (b) writeProcedure(b);
    runPane('layout', null, id);
    if (process.env.SESSION_RAIL_STARTED) state.startRan = true;
    const model = modelOf(cwd, id) || activity.claude?.model;
    activity = act.turnEnded(activity, now);
    if (model) activity.claude.model = model;
    startWatch(agent.pid, id, state);
    save();
    return null;
  }

  if (kind === 'end') {
    if (state.watchPid) { try { process.kill(state.watchPid, 'SIGTERM'); } catch { /* already gone */ } }
    const reason = String(event.reason || event.endReason || '').toLowerCase();
    const ending = !['clear', 'new', 'resume', 'load', 'compact'].includes(reason);
    if (ending) {
      runPane('close', 'rail', id);
      runPane('close', 'desk', id);
    }
    save();
    // After the save, so the write does not put the file back. A clear or a compact keeps the session.
    if (ending) forgetActivity(id);
    return null;
  }

  if (kind === 'compacted') {
    armTurn(state);
    save();
    return null;
  }

  if (kind === 'prompt') {
    armTurn(state);
    const cmd = slashCommand(promptOf(event));
    if (cmd === 'approve-brief' || cmd === 'rail' || cmd === 'desk') save();
    if (cmd === 'approve-brief') return { decision: 'block', reason: approve(cwd) };
    if (cmd === 'rail' || cmd === 'desk') return { decision: 'block', reason: panelMessage(runPane('toggle', cmd, id), cmd) };
    if (/^\/(review|code-review)\b/.test(promptOf(event).trim())) state.codeReview = { at: now };
    const said = humanAsk(promptOf(event));
    if (said) activity = act.heard(activity, said, now);
    activity = act.turnStarted(activity, activity.claude?.model || modelOf(cwd, id), now);
    save();
    return null;
  }

  if (kind === 'note') {
    const note = event.notificationType || event.notification_type;
    if (note === 'idle_prompt') { activity = act.turnEnded(activity, now); save(); }
    return null;
  }

  if (kind === 'stop' || kind === 'agent-stop') {
    const last = event.lastAssistantMessage || event.last_assistant_message || '';
    if (state.codeReview && last) {
      const report = reportFromText(last);
      const settled = report && (report.findings.length === 0 || report.findings.some((f) => typeof f.outcome === 'string'));
      if (settled) { recordCodeReview(cwd, report); state.codeReview = null; }
    }
    if (kind === 'agent-stop') {
      const aid = String(event.agent_id || event.agentId || event.subagent_id || event.subagentId || '');
      if (aid && activity.agents?.[aid]) activity = act.noteReply(activity, aid, last, now);
      else if (last) {
        const live = Object.entries(activity.agents || {}).filter(([, g]) => !g.endedAt);
        if (live.length === 1) activity = act.noteReply(activity, live[0][0], last, now);
      }
    }
    if (kind === 'stop' && !event.subagentType && !event.subagent_type) {
      activity = act.turnEnded(activity, now);
      activity = act.replied(activity, last, now);
      // The same list Claude's transcript index keeps: still-running shells and subagents. An empty
      // list clears them, so a finished shell does not leave the pet busy.
      activity = act.trackTasks(activity, event.backgroundTasks, now);
      if (Array.isArray(event.backgroundTasks)) {
        const live = new Set(event.backgroundTasks.map((t) => t.id));
        for (const agentId of Object.keys(state.liveAgents || {})) {
          if (!live.has(agentId)) {
            activity = act.agentEnded(activity, agentId, now);
            delete state.liveAgents[agentId];
          }
        }
      }
    }
    save();
    return null;
  }

  const tool = toolOf(event);
  const input = inputOf(event);
  const use = useOf(event) || `${tool}-${now}`;

  if (kind === 'pre' && EDIT.has(tool)) {
    const raw = input.file_path || input.path || input.target_file || input.notebook_path || '';
    if (raw) {
      const file = resolve(cwd, raw);
      const b = readBrief(cwd);
      const head = b ? null : gitHead(cwd);
      const checkout = head && NO_BRIEF_BRANCHES.includes(head.branch) ? { branch: head.branch, cwd: head.root || head.cwd } : null;
      const reason = editReason(b, file, checkout);
      if (reason) {
        if (b) writeProcedure(b); // the deny drops any attached procedure, so the reason points at the file
        activity = act.refused(activity, tool, file, now);
        save();
        return { decision: 'deny', reason };
      }
    }
  }

  if (kind === 'pre' && SHELL.has(tool)) {
    const write = shellEdit(cwd, input.command || '');
    if (write) {
      const b = readBrief(cwd);
      if (b) writeProcedure(b); // the deny drops any attached procedure, so the reason points at the file
      activity = act.refused(activity, tool, write.file, now);
      save();
      return { decision: 'deny', reason: write.reason };
    }
    if (mergesPr(input.command || '')) {
      const b = readBrief(cwd);
      if (b?.approval?.approvedAt) {
        const head = git(cwd, ['rev-parse', 'HEAD']);
        const runs = (readJson(reviewsFile(b.common, b.branch))?.runs ?? []).filter((r) => r && Array.isArray(r.findings));
        const reason = head ? reviewWait(runs, { head }) : null;
        if (reason) { save(); return { decision: 'deny', reason }; }
      }
    }
  }

  if (kind === 'pre') {
    if (SPAWN_TOOLS.has(tool)) {
      const what = String(input.description || '').trim();
      const named = /^([A-Za-z]+):\s+\S/.exec(what);
      const taken = Object.values(activity.agents || {});
      const name = named ? named[1] : pickName(taken.map((g) => g.name));
      const colour = pickColour([...taken.filter((g) => !g.endedAt).map((g) => g.colour)]);
      const description = named ? what : (what ? `${name}: ${what}` : name);
      const background = input.background !== false;
      const prompt = keep(input.prompt, 1500);
      const owner = event.agent_id || event.agentId;
      const parent = owner && activity.agents?.[owner] ? owner : undefined;
      activity = act.agentStarted(activity, use, {
        name, colour, what: what.replace(/^[A-Za-z]+:\s+/, ''), since: now, background,
        ...(prompt ? { prompt } : {}), ...(parent ? { parent } : {}),
      });
      activity = act.callStarted(activity, { id: use, tool: 'Agent', arg: description, since: now });
      state.pending = { ...(state.pending || {}), [use]: { name, background } };
      const context = procedure(cwd, state);
      save();
      if (description !== what || context) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...(description !== what ? { updatedInput: { ...input, description } } : {}), ...(context ? { additionalContext: context } : {}) } };
      }
      return null;
    }
    activity = act.callStarted(activity, { id: use, tool, arg: summarise(tool, input, cwd), since: now });
    const context = procedure(cwd, state);
    save();
    return context ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } } : null;
  }

  if (kind === 'post' || kind === 'fail') {
    activity = act.callFinished(activity, use, kind === 'post', now);
    if (SPAWN_TOOLS.has(tool)) {
      const grokId = resultId(event.toolResult || event.tool_response);
      const pending = state.pending?.[use];
      if (grokId && activity.agents?.[use]) {
        const agentRow = activity.agents[use];
        activity = act.agentEnded(activity, use, now);
        if (pending?.background !== false) {
          activity = act.agentStarted(activity, grokId, { ...agentRow, endedAt: undefined, since: agentRow.since });
          state.liveAgents = { ...(state.liveAgents || {}), [grokId]: true };
        }
      } else if (pending?.background === false) activity = act.agentEnded(activity, use, now);
      if (state.pending) delete state.pending[use];
    }
    save();
  }
  return reply;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invoked) {
  try {
    const raw = readFileSync(0, 'utf8');
    const event = raw.trim() ? JSON.parse(raw) : {};
    const out = handle(event, findAgent());
    if (out) console.log(JSON.stringify(out));
  } catch {
    // A broken hook stays out of the way: Grok fails open, and an edit is not stuck behind it.
  }
}
