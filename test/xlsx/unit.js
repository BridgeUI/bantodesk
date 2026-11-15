// node tmp/xlsx/unit.js — unit checks of src/main/xlsx.js date handling (env AT_APP_ROOT = app folder, default this repo)
const path = require('path');
const root = process.env.AT_APP_ROOT ? path.resolve(process.env.AT_APP_ROOT) : path.join(__dirname, '..', '..');
const X = require(path.join(root, 'src', 'main', 'xlsx.js'));
let fails = 0;
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(cond ? 'PASS' : 'FAIL', name, extra); };
const kinds = [['0.00E+00', null], ['##0.0E+0', null], ['yyyy/m/d', 'date'], ['h:mm', 'time'], ['[h]:mm', 'elapsed'], ['mm:ss', 'time'],
  ['m"月"', 'date'], ['[$-411]ggge"年"m"月"d"日"', 'date'], ['0;\\-0;"－"', null], ['#,##0', null], ['yyyy-mm-dd hh:mm', 'date']];
for (const [code, want] of kinds) ok(`dateKind ${code}`, X.dateKind(code) === want, String(X.dateKind(code)));
ok('elapsed 30.5 -> 732:00:00', X.serialToIso(30.5, false, 'elapsed') === '732:00:00', X.serialToIso(30.5, false, 'elapsed'));
ok('time 1.5 -> 12:00:00', X.serialToIso(1.5, false, 'time') === '12:00:00', X.serialToIso(1.5, false, 'time'));
ok('date 45000 -> 2023-03-15', X.serialToIso(45000, false, 'date') === '2023-03-15');
ok('date out of range -> null', X.serialToIso(1e12, false, 'date') === null);
console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
