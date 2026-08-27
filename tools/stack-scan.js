const fs = require('fs');
const lines = fs.readFileSync('/home/kev/dev/sol/testy-token/consolidated-testy-token/target/deploy/amm-dump.txt', 'utf8').split('\n');
let curFn = null;
let maxOffsets = [];
let all = [];
for (const line of lines) {
  const fnMatch = line.match(/^[0-9a-f]+ <(.+)>:$/);
  if (fnMatch) curFn = fnMatch[1];
  // matches "r10 - 0xNNN" and "[r10 - 0xNNN]" and "r10 + 0xNNN"
  const re = /r10\s*([+-])\s*0x([0-9a-f]+)/g;
  let m;
  while ((m = re.exec(line))) {
    const off = parseInt(m[2], 16) * (m[1] === '-' ? -1 : 1);
    all.push({ fn: curFn, off, line: line.trim() });
  }
}
all.sort((a, b) => a.off - b.off);
console.log('10 largest stack offsets (most negative r10):');
for (const x of all.slice(0, 10)) console.log(`  ${x.off} in <${x.fn}> :: ${x.line.slice(0, 90)}`);
