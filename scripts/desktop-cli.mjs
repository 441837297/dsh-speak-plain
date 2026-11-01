import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Runs the installed DSH CLI entry INSIDE Electron's asar-aware Node, with the
// same `manageDesktopProfile: true` capability the Desktop app itself passes.
// This is the sanctioned path for the reserved desktop profile; it is not a
// hand-edit of profile files. The running app is never restarted or killed.
const app = process.env.DSH_SMOKE_APP;
if (!app) throw new Error('Set DSH_SMOKE_APP to the installed desktop executable');
const bin = resolve(app, '..', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const { runCli } = await import(pathToFileURL(bin).href);
await runCli({ manageDesktopProfile: true });
