// A stand-in for `claude -p --model haiku` (tmp/progress-check/unit.js). Reads the prompt on stdin and answers like
// `--output-format json --json-schema`: every candidate line 「- 行 <n> (<kind>): <fact>」 of every folder becomes a fact.
// FAKE_HAIKU_MODE: ok (default) | fail (exit 1) | slow (never answers) | garbage (not JSON). FAKE_HAIKU_LOG: append the args.
const fs = require('fs');
// FAKE_HAIKU_MODE_FILE: a file holding the mode (the e2e changes it while the app runs)
let fileMode = '';
try {
  if (process.env.FAKE_HAIKU_MODE_FILE) fileMode = fs.readFileSync(process.env.FAKE_HAIKU_MODE_FILE, 'utf8').trim();
} catch {}
const mode = fileMode || process.env.FAKE_HAIKU_MODE || 'ok';
if (process.env.FAKE_HAIKU_LOG) fs.appendFileSync(process.env.FAKE_HAIKU_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
let input = '';
process.stdin.on('data', (b) => (input += b));
process.stdin.on('end', () => {
  if (process.env.FAKE_HAIKU_PROMPTS) fs.appendFileSync(process.env.FAKE_HAIKU_PROMPTS, input + '\n=====\n');
  if (mode === 'slow') return setTimeout(() => {}, 60 * 60 * 1000);
  if (mode === 'fail') {
    process.stderr.write('boom\n');
    process.exit(1);
  }
  if (mode === 'garbage') {
    process.stdout.write('not json');
    return;
  }
  const facts = [];
  let folder = -1;
  for (const line of input.split('\n')) {
    const h = /^## フォルダ (\d+):/.exec(line);
    if (h) folder = Number(h[1]);
    const m = /^- 行 (\S+) \(([\w-]+)\): (.+)$/.exec(line);
    if (m && folder >= 0) facts.push({ folder, row: m[1], fact: m[3] });
  }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { facts } }));
});
