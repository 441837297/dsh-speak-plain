import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const app = process.env.DSH_SMOKE_APP;
if (!app) throw new Error('Set DSH_SMOKE_APP to the installed desktop executable');
const resources = resolve(app, '..', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const child = spawn(app, [resources, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: resolve('.smoke/clean-home') },
  windowsHide: true,
});
const status = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1)); });
process.exitCode = status;
