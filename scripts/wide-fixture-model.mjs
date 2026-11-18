// Stand-in for the headless model when Claude or Grok isn't available. The real runner still
// builds the prompts, the worktrees and the skeptic's verdict; this only prints the JSON they parse.
const wait = Number(process.env.WIDE_FIXTURE_MS || 0);
const at = process.argv.indexOf('-p');
const prompt = at >= 0 ? String(process.argv[at + 1] ?? '') : '';
await new Promise((resolve) => setTimeout(resolve, wait));

let body;
if (/skeptic/i.test(prompt)) {
  const killed = [];
  for (const line of prompt.split('\n')) {
    const m = /^(\d+)\. /.exec(line);
    if (m && /rename|style|clarity/i.test(line)) killed.push({ index: Number(m[1]), note: 'Style only. The skeptic dropped it.' });
  }
  body = { summary: killed.length ? 'Kept the bug. The skeptic declined the style note.' : 'Nothing to drop.', killed };
} else {
  const findings = [];
  if (prompt.includes('auth.js')) findings.push({ file: 'auth.js', line: 4, severity: 'high', title: 'The session token is ignored', detail: 'login checks the password and then drops the token.' });
  if (prompt.includes('style.js')) findings.push({ file: 'style.js', line: 2, severity: 'low', title: 'Rename the loop index for clarity', detail: 'The index is named x.' });
  body = { findings };
}
process.stdout.write(JSON.stringify({ structured_output: body }));
