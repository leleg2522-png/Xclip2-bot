import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { generationErrorMessage } from '../src/generation-errors';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const helper = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'notifyGenerationFailure');
if (!helper) throw Error('Missing real generation failure notifier');
const code = ts.transpileModule(helper.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

/** Install the actual production notifier in extracted-runner test contexts. */
export function withGenerationErrors(context: vm.Context): vm.Context {
  context.generationErrorMessage = generationErrorMessage;
  vm.runInContext(code, context);
  return context;
}
