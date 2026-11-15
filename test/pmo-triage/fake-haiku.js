// A stand-in for `claude -p --model haiku` for the patrol's triage (tmp/pmo-triage). Reads the prompt on stdin and answers
// like `--output-format json --json-schema`. FAKE_HAIKU_MODE_FILE (a file holding the mode) or FAKE_HAIKU_MODE:
//   wake (default) = every 「- [<ref>] …」 line of the prompt becomes a point, wake true · quiet = wake false, no point ·
//   fail = exit 1 · slow = never answers · garbage = not JSON.
// FAKE_HAIKU_LOG: append the args (one JSON line per call) · FAKE_HAIKU_PROMPTS: append the prompt.
const fs = require('fs');
let fileMode = '';
try {
  if (process.env.FAKE_HAIKU_MODE_FILE) fileMode = fs.readFileSync(process.env.FAKE_HAIKU_MODE_FILE, 'utf8').trim();
} catch {}
const mode = fileMode || process.env.FAKE_HAIKU_MODE || 'wake';
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
  if (mode === 'garbage') return void process.stdout.write('not json');
  const points = [];
  if (mode === 'wake') {
    for (const line of input.split('\n')) {
      const m = /^- \[([^\]]+)\] (.+)$/.exec(line);
      if (m) points.push({ ref: m[1], fact: `変化あり: ${m[2].slice(0, 80)}` });
    }
  }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { wake: mode === 'wake' && points.length > 0, points } }));
});
