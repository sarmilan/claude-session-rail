// Whether a shell command writes files in the checkout. Pure, no Node APIs: the Claude hooks
// (hooks/register.ts) and Grok's hook (bin/grok-hook.mjs) both ask it, then run the same brief
// gate they use for Edit and Write on each path.
//
// This is a careful list, not a shell. A quoted mention of `>` is not a redirect, and `git log`
// stays allowed. A command that creates, overwrites, moves or deletes a file is a write. When the
// path can't be named (a variable, a glob, `git apply`), the result is `null` inside the list:
// the caller treats that as a file in the checkout, so the person can run it themselves. A script
// file (`node tool.mjs`, `python job.py`) is left alone — the desk frame and the tests are those —
// unless its `-c` / `-e` text obviously writes.

/** @typedef {{ value: string, expandable: boolean }} Word */

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash']);
const WRAPPERS = new Set(['command', 'exec', 'time', 'sudo', 'nohup', 'nice', 'builtin', 'stdbuf']);
const EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'emacsclient', 'ed', 'ex', 'pico', 'hx', 'helix', 'joe', 'jed']);
const FILE_CMDS = new Set(['cp', 'mv', 'rm', 'ln', 'install', 'mkdir', 'rmdir', 'touch', 'unlink', 'shred', 'truncate', 'chmod', 'chown', 'chgrp', 'sponge']);
const COMPRESS = new Set(['gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', 'zip']);
const PM_WRITE = new Set(['install', 'i', 'ci', 'add', 'update', 'uninstall', 'remove', 'rm', 'link', 'unlink', 'rebuild']);
const GIT_SAFE = new Set([
  'status', 'st', 'log', 'diff', 'show', 'blame', 'grep', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'cat-file', 'describe', 'shortlog', 'reflog', 'show-ref', 'for-each-ref', 'name-rev', 'merge-base',
  'symbolic-ref', 'check-ignore', 'check-attr', 'count-objects', 'fsck', 'verify-commit', 'verify-tag',
  'version', 'help', 'var', '--version', '--help', 'branch', 'tag', 'remote', 'fetch', 'push', 'add',
  'commit', 'difftool', 'range-diff', 'whatchanged', 'show-branch', 'notes', 'interpret-trailers',
  'mailinfo', 'stripspace', 'config',
]);
const STDIN_WRITERS = new Set(['rm', 'mv', 'cp', 'tee', 'ln', 'mkdir', 'touch', 'sed', 'perl', 'ruby', 'dd', 'vim', 'vi', 'nvim', 'nano', 'sh', 'bash']);

const baseOf = (cmd) => String(cmd ?? '').split('/').pop();

/** A redirect at /dev/null (and the other non-files) is not a checkout write. */
function isDevice(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return false;
  return /^\/dev\/(null|tty|stdout|stderr|stdin|zero|full|fd\/\d+|pts\/\d+)$/.test(p.replace(/\/{2,}/g, '/'));
}

/**
 * Absolute path of a literal write target, with `.` and `..` folded. `cwd` is the session's
 * working directory. A relative target joins onto it.
 * @param {string} cwd
 * @param {string} target
 */
export function resolveWritePath(cwd, target) {
  const raw = String(target ?? '');
  if (!raw || raw.includes('\0')) return null;
  const base = String(cwd ?? '').replace(/\/$/, '');
  const joined = raw.startsWith('/') ? raw : `${base}/${raw}`;
  const parts = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/**
 * Paths a command would create, overwrite, move or delete.
 * `null` when the command does not write a file.
 * An entry of `null` is a write whose path is not a literal (treat it as inside the checkout).
 * Device sinks are omitted.
 * @param {string} command
 * @param {number} [depth]
 * @returns {(string | null)[] | null}
 */
export function shellWrites(command, depth = 0) {
  if (depth > 8) return [null];
  const text = String(command ?? '');
  if (!text.trim()) return null;
  const found = [];
  for (const cmd of scan(text)) {
    for (const target of cmd.redirects) {
      if (target == null) found.push(null);
      else if (!isDevice(target)) found.push(target);
    }
    const extra = commandWrites(stripWrappers(cmd.argv), depth);
    if (extra) {
      for (const target of extra) {
        if (target == null || !isDevice(target)) found.push(target ?? null);
      }
    }
  }
  return found.length ? found : null;
}

/** @param {Word[]} argv */
function stripWrappers(argv) {
  const a = [...argv];
  while (a.length) {
    const v = a[0].value;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) { a.shift(); continue; }
    if (v === 'env') { a.shift(); continue; }
    if (!WRAPPERS.has(baseOf(v))) break;
    const wrap = baseOf(v);
    a.shift();
    if (wrap === 'sudo') {
      while (a.length && a[0].value.startsWith('-')) {
        const flag = a.shift().value;
        if (['-u', '-g', '-h', '-p', '-C', '-T'].includes(flag) && a[0] && !a[0].value.startsWith('-')) a.shift();
      }
    } else if (wrap === 'stdbuf' || wrap === 'nice' || wrap === 'time') {
      while (a.length && a[0].value.startsWith('-')) a.shift();
    }
  }
  return a;
}

/**
 * @param {Word[]} argv
 * @param {number} depth
 * @returns {(string | null)[] | null}
 */
function commandWrites(argv, depth) {
  if (!argv.length) return null;
  const cmd = baseOf(argv[0].value);
  const args = argv.slice(1);
  if (SHELLS.has(cmd)) return shellDashC(args, depth);
  if (cmd === 'eval') {
    if (args.some((a) => a.expandable)) return [null];
    return shellWrites(args.map((a) => a.value).join(' '), depth + 1);
  }
  if (cmd === 'xargs') return xargsWrites(args, depth);
  if (cmd === 'find') return findWrites(args, depth);
  if (cmd === 'git') return gitWrites(args, depth);
  if (EDITORS.has(cmd)) return editorWrites(args);
  if (cmd === 'sed') return sedWrites(args);
  if (cmd === 'perl' || cmd === 'ruby' || cmd === 'gawk') return inplaceWrites(cmd, args);
  if (cmd === 'bun') {
    const code = evalCode(cmd, args);
    return code ?? pmWrites(cmd, args);
  }
  if (cmd === 'python' || cmd === 'python3' || cmd === 'node' || cmd === 'deno') return evalCode(cmd, args);
  if (cmd === 'dd') return ddWrites(args);
  if (cmd === 'curl') return curlWrites(args);
  if (cmd === 'wget') return wgetWrites(args);
  if (cmd === 'patch') return args.some((a) => a.value === '--dry-run' || a.value === '--check') ? null : [null];
  if (cmd === 'rsync') return args.some((a) => a.value === '-n' || a.value === '--dry-run') ? null : flagPaths(args);
  if (cmd === 'tar') return tarWrites(args);
  if (cmd === 'unzip') return args.some((a) => a.value === '-l' || a.value === '-t' || a.value === '-p' || a.value === '--list') ? null : [null];
  if (COMPRESS.has(cmd)) return compressWrites(args);
  if (cmd === 'make' || cmd === 'gmake') return makeWrites(args);
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'yarnpkg' || cmd === 'bun') return pmWrites(cmd, args);
  if (cmd === 'tee') return teeWrites(args);
  if (FILE_CMDS.has(cmd)) return flagPaths(args);
  if (cmd === 'source' || cmd === '.') return [null];
  return null;
}

/** @param {Word[]} args @param {number} depth */
function shellDashC(args, depth) {
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    const dashC = v === '-c' || (v.startsWith('-') && !v.startsWith('--') && v.includes('c'));
    if (!dashC) continue;
    const script = args[i + 1];
    if (!script || script.expandable) return [null];
    return shellWrites(script.value, depth + 1);
  }
  return null;
}

/** @param {Word[]} args @param {number} depth */
function xargsWrites(args, depth) {
  /** @type {Word[]} */
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (v === '--') { rest.push(...args.slice(i + 1)); break; }
    if (v.startsWith('-')) {
      if (['-I', '-a', '-E', '-e', '-L', '-n', '-P', '-s'].includes(v) || v.startsWith('--')) {
        if (!v.includes('=') && ['-I', '-a', '-E', '-e', '-L', '-n', '-P', '-s'].includes(v)) i++;
      }
      continue;
    }
    rest.push(args[i]);
  }
  if (!rest.length) return null;
  const name = baseOf(rest[0].value);
  const nested = shellWrites(rest.map((a) => a.value).join(' '), depth + 1);
  if (STDIN_WRITERS.has(name)) return nested ? [null, ...nested] : [null];
  return nested;
}

/** @param {Word[]} args @param {number} depth */
function findWrites(args, depth) {
  const vals = args.map((a) => a.value);
  if (vals.includes('-delete')) return [null];
  for (const flag of ['-exec', '-execdir', '-ok', '-okdir']) {
    const at = vals.indexOf(flag);
    if (at < 0) continue;
    const end = vals.indexOf(';', at);
    const cmdArgs = args.slice(at + 1, end === -1 ? args.length : end).filter((a) => a.value !== '{}' && a.value !== '+');
    const nested = shellWrites(cmdArgs.map((a) => a.value).join(' '), depth + 1);
    const name = baseOf(cmdArgs[0]?.value);
    if (STDIN_WRITERS.has(name)) return nested ? [null, ...nested] : [null];
    if (nested) return nested;
  }
  return null;
}

/** Non-option operands, as literals or `null` when the word expands. Empty words are dropped. `null` result means no path. */
function flagPaths(args) {
  /** @type {(string | null)[]} */
  const out = [];
  let dash = false;
  for (const a of args) {
    if (dash) { out.push(a.expandable ? null : a.value); continue; }
    if (a.value === '--') { dash = true; continue; }
    if (a.value.startsWith('-') && a.value !== '-') continue;
    if (a.value === '') continue;
    out.push(a.expandable ? null : a.value);
  }
  const paths = out.filter((p) => p !== '');
  return paths.length ? paths : null;
}

/** @param {Word[]} args */
function teeWrites(args) {
  if (args.some((a) => a.value === '--help' || a.value === '--version')) return null;
  return flagPaths(args.filter((a) => a.value !== '-a' && a.value !== '--append' && a.value !== '-i' && a.value !== '-p' && a.value !== '--ignore-interrupts'));
}

/** @param {Word[]} args */
function editorWrites(args) {
  if (args.some((a) => a.value === '--version' || a.value === '--help' || a.value === '-h' || a.value === '-v' || a.value === '--version')) {
    if (args.every((a) => a.value.startsWith('-'))) return null;
  }
  const files = args.filter((a) => !a.value.startsWith('-') && !a.value.startsWith('+'));
  if (!files.length) return args.some((a) => a.value === '--version' || a.value === '--help' || a.value === '-h') ? null : [null];
  return flagPaths(files);
}

/** @param {Word[]} args */
function sedWrites(args) {
  const inplace = args.some((a) => a.value === '-i' || /^(-i|--in-place)/.test(a.value));
  if (!inplace) return null;
  /** @type {Word[]} */
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (v === '--') { operands.push(...args.slice(i + 1)); break; }
    if (v === '-e' || v === '-f' || v === '--expression' || v === '--file') { i++; continue; }
    if (v.startsWith('-')) continue;
    operands.push(args[i]);
  }
  const paths = flagPaths(operands);
  return paths ?? [null];
}

/** @param {string} cmd @param {Word[]} args */
function inplaceWrites(cmd, args) {
  const inplace = args.some((a) => a.value === '-i' || a.value.startsWith('-i') || a.value.startsWith('--in-place') || /^-[pPn]*i/.test(a.value) || a.value === '--inplace');
  const code = evalCode(cmd, args);
  if (!inplace) return code;
  /** @type {Word[]} */
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (v === '--') { operands.push(...args.slice(i + 1)); break; }
    if (v === '-e' || v === '-E' || v === '--expression') { i++; continue; }
    if (v.startsWith('-')) continue;
    operands.push(args[i]);
  }
  const paths = flagPaths(operands);
  return paths ?? code ?? [null];
}

/** Obvious writes inside `python -c` / `node -e` / `perl -e`. Paths when a literal is there, else `null`. */
function codeWrites(code) {
  if (!code) return null;
  const writes = /writeFile|appendFile|unlinkSync|\bunlink\b|rmSync|rmdir|mkdirSync|\bmkdir\b|os\.remove|os\.unlink|shutil\.|write_text|write_bytes|createWriteStream|truncate\s*\(|open\s*\([^)]*['"][wax+][^'"]*['"]/;
  if (!writes.test(code)) return null;
  /** @type {string[]} */
  const paths = [];
  const re = /(['"])([^'"\n]{1,180})\1/g;
  let m;
  while ((m = re.exec(code))) {
    if (/^[rwaxtb+]+$/.test(m[2])) continue;
    paths.push(m[2]);
  }
  return paths.length ? paths : [null];
}

/** @param {string} cmd @param {Word[]} args */
function evalCode(cmd, args) {
  const flags = cmd === 'node' || cmd === 'deno' || cmd === 'bun' ? ['-e', '--eval'] : ['-c', '-e'];
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (v.startsWith('--eval=')) return codeWrites(v.slice('--eval='.length));
    if (flags.includes(v)) {
      const code = args[i + 1];
      if (!code || code.expandable) return [null];
      return codeWrites(code.value);
    }
  }
  return null;
}

/** @param {Word[]} args */
function ddWrites(args) {
  /** @type {(string | null)[]} */
  const out = [];
  for (const a of args) {
    if (!a.value.startsWith('of=')) continue;
    const p = a.value.slice(3);
    out.push(a.expandable || !p ? null : p);
  }
  return out.length ? out : null;
}

/** @param {Word[]} args */
function curlWrites(args) {
  /** @type {(string | null)[]} */
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (v === '-o' || v === '--output') {
      const next = args[++i];
      if (next && next.value !== '-') out.push(next.expandable ? null : next.value);
    } else if (v.startsWith('--output=')) {
      const p = v.slice('--output='.length);
      if (p && p !== '-') out.push(p);
    } else if (v.startsWith('-o') && v.length > 2 && !v.startsWith('--')) {
      const p = v.slice(2);
      if (p !== '-') out.push(p);
    } else if (v === '-O' || v === '--remote-name') out.push(null);
  }
  return out.length ? out : null;
}

/** @param {Word[]} args */
function wgetWrites(args) {
  /** @type {(string | null)[]} */
  const files = [];
  let stdout = false;
  let url = false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (v === '-O' || v === '--output-document') {
      const next = args[++i];
      if (!next || next.value === '-') stdout = true;
      else files.push(next.expandable ? null : next.value);
    } else if (v.startsWith('--output-document=')) {
      const p = v.slice('--output-document='.length);
      if (p === '-') stdout = true;
      else if (p) files.push(p);
    } else if (v.startsWith('-') && !v.startsWith('--') && v.includes('O')) {
      const rest = v.slice(v.lastIndexOf('O') + 1);
      if (rest === '-') stdout = true;
      else if (rest) files.push(rest);
      else {
        const next = args[++i];
        if (!next || next.value === '-') stdout = true;
        else files.push(next.expandable ? null : next.value);
      }
    } else if (!v.startsWith('-')) url = true;
  }
  if (files.length) return files;
  if (url && !stdout) return [null];
  return null;
}

/** @param {Word[]} args */
function compressWrites(args) {
  if (args.some((a) => ['-c', '--stdout', '--to-stdout', '-l', '--list', '-t', '--test'].includes(a.value))) return null;
  return flagPaths(args);
}

/** @param {Word[]} args */
function tarWrites(args) {
  if (!args.length) return null;
  const first = args[0].value;
  let mode = '';
  if (!first.startsWith('-') && /^[acxturA-z]*$/.test(first) && /[acxt]/.test(first)) mode = first;
  for (const a of args) {
    if (a.value === '--extract' || a.value === '--get') mode += 'x';
    else if (a.value === '--create') mode += 'c';
    else if (a.value === '--list') mode += 't';
    else if (a.value.startsWith('-') && !a.value.startsWith('--')) mode += a.value.slice(1);
  }
  if (mode.includes('t') && !mode.includes('x')) return null;
  if (mode.includes('x')) return [null];
  if (!mode.includes('c') && !mode.includes('r') && !mode.includes('u')) return null;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (v === '-f' || v === '--file') {
      const n = args[i + 1];
      return [n ? (n.expandable ? null : n.value) : null];
    }
    if (v.startsWith('--file=')) return [v.slice('--file='.length) || null];
    if (!v.startsWith('--') && v.includes('f') && (v.startsWith('-') || v === first)) {
      const n = args[i + 1];
      return [n ? (n.expandable ? null : n.value) : null];
    }
  }
  return null;
}

/** @param {Word[]} args */
function makeWrites(args) {
  if (args.some((a) => a.value === '-n' || a.value === '--dry-run' || a.value === '-q' || a.value === '--question')) return null;
  const goals = args.filter((a) => !a.value.startsWith('-') && !a.value.includes('=')).map((a) => a.value);
  if (goals.length && goals.every((g) => g === 'test' || g === 'check' || g === 'lint' || g === 'tests')) return null;
  return [null];
}

/** @param {string} cmd @param {Word[]} args */
function pmWrites(cmd, args) {
  const sub = args.find((a) => !a.value.startsWith('-'))?.value;
  if (cmd === 'yarn' || cmd === 'yarnpkg') {
    if (!sub || PM_WRITE.has(sub)) return [null];
    return null;
  }
  if (sub && PM_WRITE.has(sub)) return [null];
  return null;
}

/** @param {Word[]} args @param {number} depth */
function gitWrites(args, depth) {
  let i = 0;
  let relocated = false;
  while (i < args.length) {
    const v = args[i].value;
    if (v === '--') { i++; break; }
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'].includes(v)) {
      if (v === '-C' || v === '--work-tree' || v === '--git-dir') relocated = true;
      i += 2;
      continue;
    }
    if (v.startsWith('--git-dir=') || v.startsWith('--work-tree=') || v.startsWith('--namespace=') || v.startsWith('--config-env=')) {
      if (v.startsWith('--work-tree=') || v.startsWith('--git-dir=')) relocated = true;
      i++;
      continue;
    }
    if (v.startsWith('-c') && v !== '-c') { i++; continue; }
    if (v.startsWith('-')) { i++; continue; }
    break;
  }
  if (i >= args.length) return null;
  const sub = args[i].value;
  const rest = args.slice(i + 1);
  const writes = gitSub(sub, rest, depth);
  if (writes && relocated) return [null];
  return writes;
}

/**
 * @param {string} sub
 * @param {Word[]} rest
 * @param {number} depth
 * @returns {(string | null)[] | null}
 */
function gitSub(sub, rest, depth) {
  switch (sub) {
    case 'checkout': return gitCheckout(rest);
    case 'switch': return gitSwitch(rest);
    case 'restore': return gitRestore(rest);
    case 'reset': return rest.some((a) => a.value === '--hard') ? [null] : null;
    case 'clean': return gitClean(rest);
    case 'apply': return gitApply(rest);
    case 'stash': return gitStash(rest);
    case 'rm':
    case 'mv': return flagPaths(rest) ?? [null];
    case 'config': return gitConfig(rest);
    case 'worktree': return gitWorktree(rest);
    case 'submodule': return gitSubmodule(rest, depth);
    case 'archive': return gitArchive(rest);
    case 'format-patch':
    case 'am':
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
    case 'revert':
    case 'pull':
    case 'clone':
      return [null];
    default:
      return GIT_SAFE.has(sub) ? null : [null];
  }
}

/** @param {Word[]} rest */
function gitCheckout(rest) {
  let create = false;
  let force = false;
  /** @type {Word[]} */
  const positionals = [];
  /** @type {Word[]} */
  const paths = [];
  let after = false;
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i].value;
    if (after) { paths.push(rest[i]); continue; }
    if (v === '--') { after = true; continue; }
    if (v === '-b' || v === '-B' || v === '--orphan') {
      create = true;
      if (rest[i + 1] && !rest[i + 1].value.startsWith('-')) i++;
      continue;
    }
    if (v.startsWith('--orphan=')) { create = true; continue; }
    if (v === '-f' || v === '--force' || v === '-m' || v === '--merge' || v === '--ours' || v === '--theirs') { force = true; continue; }
    if (v.startsWith('-')) continue;
    positionals.push(rest[i]);
  }
  if (paths.length) return literalWords(paths);
  if (force) return [null];
  if (create && positionals.length === 0) return null;
  if (create) return [null];
  if (!positionals.length) return null;
  // `git checkout README.md` is a path; `git checkout main` changes the tree and the files aren't named.
  if (positionals.every((p) => p.value.includes('/') || p.value.includes('.'))) return literalWords(positionals);
  return [null];
}

/** @param {Word[]} rest */
function gitSwitch(rest) {
  let create = false;
  /** @type {Word[]} */
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i].value;
    if (v === '-c' || v === '-C' || v === '--create' || v === '--force-create') {
      create = true;
      if (rest[i + 1] && !rest[i + 1].value.startsWith('-')) i++;
      continue;
    }
    if (v.startsWith('--create=') || v.startsWith('--force-create=')) { create = true; continue; }
    if (v.startsWith('-')) continue;
    positionals.push(rest[i]);
  }
  if (create && positionals.length === 0) return null;
  if (!create && positionals.length === 0) return null;
  return [null];
}

/** @param {Word[]} rest */
function gitRestore(rest) {
  let staged = false;
  let worktree = false;
  let source = false;
  /** @type {Word[]} */
  const paths = [];
  let after = false;
  for (const a of rest) {
    const v = a.value;
    if (v === '--') { after = true; continue; }
    if (after) { paths.push(a); continue; }
    if (v === '--staged') { staged = true; continue; }
    if (v === '--worktree') { worktree = true; continue; }
    if (v === '--source' || v.startsWith('--source=')) { source = true; continue; }
    if (v.startsWith('-')) continue;
    paths.push(a);
  }
  if (staged && !worktree && !source) return null;
  return paths.length ? literalWords(paths) : [null];
}

/** @param {Word[]} rest */
function gitClean(rest) {
  const dry = rest.some((a) => a.value === '-n' || a.value === '--dry-run' || (a.value.startsWith('-') && !a.value.startsWith('--') && a.value.includes('n')));
  return dry ? null : [null];
}

/** @param {Word[]} rest */
function gitApply(rest) {
  const v = rest.map((a) => a.value);
  if (v.some((f) => f === '--check' || f === '--stat' || f === '--summary' || f === '--numstat' || f === '--cached')) return null;
  return [null];
}

/** @param {Word[]} rest */
function gitStash(rest) {
  const sub = rest.find((a) => !a.value.startsWith('-'))?.value;
  if (sub && ['list', 'show', 'drop', 'clear', 'create', 'store'].includes(sub)) return null;
  return [null];
}

/** @param {Word[]} rest */
function gitConfig(rest) {
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i].value;
    if (v === '-f' || v === '--file') {
      const n = rest[i + 1];
      return [n ? (n.expandable ? null : n.value) : null];
    }
    if (v.startsWith('--file=')) return [v.slice('--file='.length) || null];
  }
  return null;
}

/** @param {Word[]} rest */
function gitWorktree(rest) {
  const sub = rest.find((a) => !a.value.startsWith('-'))?.value;
  if (!sub || sub === 'list') return null;
  return [null];
}

/** @param {Word[]} rest @param {number} depth */
function gitSubmodule(rest, depth) {
  const sub = rest.find((a) => !a.value.startsWith('-'))?.value;
  if (!sub || sub === 'status' || sub === 'summary') return null;
  if (sub === 'foreach') {
    const at = rest.findIndex((a) => a.value === 'foreach');
    return shellWrites(rest.slice(at + 1).map((a) => a.value).join(' '), depth + 1);
  }
  return [null];
}

/** @param {Word[]} rest */
function gitArchive(rest) {
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i].value;
    if (v === '--output' || v === '-o') {
      const n = rest[i + 1];
      return [n ? (n.expandable ? null : n.value) : null];
    }
    if (v.startsWith('--output=')) return [v.slice('--output='.length) || null];
  }
  return null;
}

/** @param {Word[]} words */
function literalWords(words) {
  /** @type {(string | null)[]} */
  const out = [];
  for (const w of words) out.push(w.expandable ? null : w.value);
  return out.length ? out : [null];
}

/**
 * Simple commands in `command`, split on unquoted separators. Heredoc bodies are data, not commands.
 * Quoted text is one word, so `echo "cat > file"` has no redirect.
 * @param {string} command
 * @returns {{ argv: Word[], redirects: (string | null)[] }[]}
 */
function scan(command) {
  const s = command;
  let i = 0;
  /** @type {{ argv: Word[], redirects: (string | null)[] }[]} */
  const cmds = [];

  const peek = () => s[i];
  /** @param {string | null} closer */
  function parse(closer) {
    /** @type {Word[]} */
    let argv = [];
    /** @type {(string | null)[]} */
    let redirects = [];
    let depth = closer === ')' ? 1 : 0;
    const flush = () => {
      if (argv.length || redirects.length) cmds.push({ argv, redirects });
      argv = [];
      redirects = [];
    };
    while (i < s.length) {
      const c = peek();
      if (closer === '`' && c === '`') { flush(); return; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '\n' || c === ';') { flush(); i++; continue; }
      if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (c === '&' && s[i + 1] === '&') { flush(); i += 2; continue; }
      if (c === '|' && (s[i + 1] === '|' || s[i + 1] === '&')) { flush(); i += 2; continue; }
      if (c === '|' || c === '&') { flush(); i++; continue; }
      if (c === '(') { depth++; flush(); i++; continue; }
      if (c === ')') {
        if (closer === ')' && depth <= 1) { flush(); return; }
        depth = Math.max(0, depth - 1);
        flush();
        i++;
        continue;
      }
      if (c === '`' ) { i++; parse('`'); if (s[i] === '`') i++; continue; }
      if (c === '$' && s[i + 1] === '(') { i += 2; parse(')'); if (s[i] === ')') i++; continue; }
      if ((c === '>' || c === '<') && s[i + 1] === '(') { i += 2; parse(')'); if (s[i] === ')') i++; continue; }
      if (matchRedirect(redirects)) continue;
      const word = readWord();
      if (word.value !== '' || word.quoted) argv.push(word);
    }
    flush();
  }

  /** @param {(string | null)[]} redirects */
  function matchRedirect(redirects) {
    let j = i;
    while (j < s.length && /[0-9]/.test(s[j])) j++;
    const rest = s.slice(j);
    let op = '';
    let kind = '';
    if (rest.startsWith('&>>')) { op = '&>>'; kind = 'out'; }
    else if (rest.startsWith('&>')) { op = '&>'; kind = 'out'; }
    else if (rest.startsWith('>>')) { op = '>>'; kind = 'out'; }
    else if (rest.startsWith('>&')) { op = '>&'; kind = 'dupout'; }
    else if (rest.startsWith('>|')) { op = '>|'; kind = 'out'; }
    else if (rest.startsWith('<>')) { op = '<>'; kind = 'out'; }
    else if (rest.startsWith('<<<')) { op = '<<<'; kind = 'herestring'; }
    else if (rest.startsWith('<<-')) { op = '<<-'; kind = 'heredoc'; }
    else if (rest.startsWith('<<')) { op = '<<'; kind = 'heredoc'; }
    else if (rest.startsWith('<&')) { op = '<&'; kind = 'dupin'; }
    else if (rest.startsWith('<')) { op = '<'; kind = 'in'; }
    else if (rest.startsWith('>')) { op = '>'; kind = 'out'; }
    else return false;
    i = j + op.length;
    if (kind === 'heredoc') { skipHeredoc(op === '<<-'); return true; }
    if (kind === 'herestring') { readWord(); return true; }
    skipHspace();
    if (i >= s.length || s[i] === '\n' || s[i] === '#' || s[i] === ';' || s[i] === '|' || s[i] === '&') {
      if (kind === 'out' || kind === 'dupout') redirects.push(null);
      return true;
    }
    const target = readWord();
    if (kind === 'in' || kind === 'dupin') return true;
    if (kind === 'dupout' && (/^\d+$/.test(target.value) || target.value === '-')) return true;
    redirects.push(target.expandable || target.value === '' ? null : target.value);
    return true;
  }

  function skipHeredoc(stripTabs) {
    const delim = readWord();
    while (i < s.length && s[i] !== '\n') i++;
    if (s[i] === '\n') i++;
    const d = delim.value;
    while (i < s.length) {
      const start = i;
      while (i < s.length && s[i] !== '\n') i++;
      let line = s.slice(start, i);
      if (s[i] === '\n') i++;
      if (stripTabs) line = line.replace(/^\t+/, '');
      if (line === d) return;
    }
  }

  function skipHspace() {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r')) i++;
  }

  /** @returns {Word & { quoted: boolean }} */
  function readWord() {
    let value = '';
    let expandable = false;
    let quoted = false;
    let quote = '';
    while (i < s.length) {
      const c = s[i];
      if (!quote) {
        if (c === '\\') {
          i++;
          if (s[i] === '\n') { i++; continue; }
          if (i < s.length) value += s[i++];
          continue;
        }
        if (c === "'" || c === '"') { quote = c; quoted = true; i++; continue; }
        if (c === '$' && s[i + 1] === '(') { i += 2; parse(')'); if (s[i] === ')') i++; expandable = true; continue; }
        if (c === '`') { i++; parse('`'); if (s[i] === '`') i++; expandable = true; continue; }
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || '();|&<>#'.includes(c)) break;
        if ((c === '~' && value === '') || c === '$' || c === '`' || c === '*' || c === '?' || c === '[') expandable = true;
        value += c;
        i++;
        continue;
      }
      if (quote === "'") {
        if (c === "'") { quote = ''; i++; continue; }
        value += c;
        i++;
        continue;
      }
      if (c === '"') { quote = ''; i++; continue; }
      if (c === '\\') { i++; if (i < s.length) value += s[i++]; continue; }
      if (c === '$' && s[i + 1] === '(') { i += 2; parse(')'); if (s[i] === ')') i++; expandable = true; continue; }
      if (c === '`') { i++; parse('`'); if (s[i] === '`') i++; expandable = true; continue; }
      if (c === '$' || c === '`') expandable = true;
      value += c;
      i++;
    }
    return { value, expandable, quoted };
  }

  parse(null);
  return cmds;
}
