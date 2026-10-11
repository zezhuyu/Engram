import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const paths = ['packages', 'tests', 'scripts'];
let failures = 0;
let checked = 0;
async function inspect(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await inspect(file);
    else if (file.endsWith('.ts')) {
      checked++;
      const source = await fs.readFile(file, 'utf8');
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') report('eval is forbidden', node);
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') report('dynamic Function is forbidden', node);
        if (ts.isDebuggerStatement(node)) report('debugger statement', node);
        ts.forEachChild(node, visit);
      }
      function report(message, node) {
        const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
        console.error(`${file}:${line}: ${message}`);
        failures++;
      }
      visit(parsed);
      if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(source)) { console.error(`${file}: unresolved merge marker`); failures++; }
    }
  }
}
for (const dir of paths) await inspect(dir);
console.log(`Static safety lint: ${checked} TypeScript files; ${failures} failures`);
process.exitCode = failures ? 1 : 0;
