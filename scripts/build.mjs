import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/index.js'], outfile: 'lib/index.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node22',
  external: ['@deepseek-ai/*', 'zod'], sourcemap: true,
});
const client = await build({
  entryPoints: ['src/client.jsx'], outfile: 'lib/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  loader: { '.css': 'text' }, sourcemap: true, write: false,
  plugins: [{ name: 'genui-css-modules', setup(plugin) {
    plugin.onLoad({ filter: /\.module\.css$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'local-css' }));
  } }],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' },
});
const css = client.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
for (const file of client.outputFiles) {
  if (file.path.endsWith('.css') || file.path.endsWith('.css.map')) continue;
  const content = file.path.endsWith('client.js')
    ? file.text.replace('"__DSH_SPEAK_PLAIN_GENUI_CSS_TEXT__"', JSON.stringify(css))
    : file.contents;
  await writeFile(file.path, content);
}
console.log(`Built ${pkg.name}@${pkg.version}`);
