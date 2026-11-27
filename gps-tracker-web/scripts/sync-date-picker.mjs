// Copies src/lib/datePicker.js into the standalone demo mockup, whose CSP allows inline scripts only.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('src/lib/datePicker.js', root), 'utf8').replace('export function', 'function');
const target = new URL('public/fleet-preview/fleet-v1.html', root);
const html = readFileSync(target, 'utf8');
const start = '<!--serial-date-picker:start-->', end = '<!--serial-date-picker:end-->';
const block = `${start}<script>\n${source}\ninstallDatePicker(document);\n</script>${end}`;
const at = html.indexOf(start);
const next = at >= 0
  ? html.slice(0, at) + block + html.slice(html.indexOf(end) + end.length)
  : html.replace(/<\/body>(?![\s\S]*<\/body>)/, () => `${block}</body>`); // function form: the code contains `$` patterns
if (next === html) console.log('demo already in sync');
else { writeFileSync(target, next); console.log('demo date picker updated'); }
