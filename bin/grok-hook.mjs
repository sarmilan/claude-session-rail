#!/usr/bin/env node
// Grok's side of the session rail. One command hook for every event: Grok writes the event as JSON on
// stdin and this process exits. Interactive `grok` only (a headless `grok -p` has no TTY and must not
// open panes or gate an outer session). The Claude plugin stays in hooks/register.ts.
//
// It opens the desk and the rail, keeps the Now feed, refuses code edits until the brief is approved,
// refuses `gh pr merge` until the reviews are in, and records a /review report. The go-ahead and
// auto-compact run in grok-watch.mjs, because a hook can't type into the session on its own.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as act from './activity.mjs';
import { briefInstructions } from './brief-instructions.mjs';
import { approvalRecord, briefFile, briefStatus, NO_BRIEF_BRANCHES, parseBrief } from './brief.mjs';
import { codeRun, gateReason as reviewWait, keptRuns, mergesPr, reportFromText, reviewsFile } from './cadence.mjs';
import { findAgent, railHome } from './host.mjs';
import { pickColour, pickName } from './names.mjs';

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
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5_000 }).trim(); } catch { return null; }
};

export function gitHead(cwd) {
  const out = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--abbrev-ref', 'HEAD']);
  if (!out) return null;
  const [common, branch] = out.split('\n');
  return common && branch ? { cwd, common, branch } : null;
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

// Why an edit of `file` (absolute) is refused, or null to let it through.
export function editReason(b, file) {
  if (!b) return null;
  if (file === b.approvedPath) return 'session-rail: only the person approves the brief, in the desk or with /approve-brief.';
  if ((file && file.startsWith(b.dir)) || b.approval?.approvedAt) return null;
  const where = `The brief for ${b.branch} is at ${b.path}. The procedure is in ${join(RAIL, 'grok-brief.md')}.`;
  if (b.text === null) return `session-rail: code edits wait for the session brief. Write it first. ${where}`;
  const brief = parseBrief(b.text);
  if (brief.missing.length) return `session-rail: code edits wait for the session brief, which is missing: ${brief.missing.join(', ')}. ${where}`;
  return `session-rail: the session brief is complete but not approved yet. Ask the person to review it in the desk's Plan tab and press Approve there, then carry on. ${where}`;
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

// The brief procedure, once per session (again after a compaction). Null when there's nothing to attach.
function procedure(cwd, state) {
  if (state.briefSent) return null;
  const b = readBrief(cwd);
  if (!b) return null;
  state.briefSent = true;
  return writeProcedure(b);
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
    if (!['clear', 'new', 'resume', 'load', 'compact'].includes(reason)) {
      runPane('close', 'rail', id);
      runPane('close', 'desk', id);
    }
    save();
    return null;
  }

  if (kind === 'compacted') {
    state.briefSent = false;
    save();
    return null;
  }

  if (kind === 'prompt') {
    const cmd = slashCommand(promptOf(event));
    if (cmd === 'approve-brief') return { decision: 'block', reason: approve(cwd) };
    if (cmd === 'rail' || cmd === 'desk') return { decision: 'block', reason: panelMessage(runPane('toggle', cmd, id), cmd) };
    if (/^\/(review|code-review)\b/.test(promptOf(event).trim())) state.codeReview = { at: now };
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
    if (kind === 'stop' && !event.subagentType && !event.subagent_type) {
      activity = act.turnEnded(activity, now);
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
      const reason = editReason(b, file);
      if (reason) {
        if (b) writeProcedure(b); // the deny drops any attached procedure, so the reason points at the file
        activity = act.refused(activity, tool, file, now);
        save();
        return { decision: 'deny', reason };
      }
    }
  }

  if (kind === 'pre' && SHELL.has(tool) && mergesPr(input.command || '')) {
    const b = readBrief(cwd);
    if (b?.approval?.approvedAt) {
      const head = git(cwd, ['rev-parse', 'HEAD']);
      const runs = (readJson(reviewsFile(b.common, b.branch))?.runs ?? []).filter((r) => r && Array.isArray(r.findings));
      const reason = head ? reviewWait(runs, { head }) : null;
      if (reason) { save(); return { decision: 'deny', reason }; }
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
      activity = act.agentStarted(activity, use, { name, colour, what: what.replace(/^[A-Za-z]+:\s+/, ''), since: now, background });
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
