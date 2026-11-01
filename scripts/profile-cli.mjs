import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

// Uses the REAL user DSH home (unlike runtime-cli.mjs, which is isolated .smoke/clean-home).
// Only the plugin CLI is invoked; the running app is not restarted or killed.
const app = process.env.DSH_SMOKE_APP;
if (!app) throw new Error('Set DSH_SMOKE_APP to the installed desktop executable');
const dshHome = process.env.DSH_REAL_HOME || join(homedir(), '.dsh');
const bin = resolve(app, '..', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const child = spawn(app, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome },
});
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', value => done(value ?? 1)); });
process.exitCode = code;
