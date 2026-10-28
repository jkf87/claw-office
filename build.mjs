// Builds the plugin by hand rather than with `openclaw plugins build`: the office's models (.glb, imported
// with Vite's ?url) need a loader of their own. The browser bundle goes in dist/control-ui/<hash>/ and its
// paths into openclaw.plugin.json's controlUi, as the prebuilt-bundle route in docs/plugins/feature-plugins.md says.
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The office never lets its dog out (Claw Office has no dog), so the dog models stay out of the bundle:
// their URLs are empty and nothing ever loads them.
const glb = {
  name: 'glb-url',
  setup(b) {
    b.onResolve({ filter: /dog-[a-z]+\.glb\?url$/ }, () => ({ path: 'dog', namespace: 'no-dog' }));
    b.onLoad({ filter: /.*/, namespace: 'no-dog' }, () => ({ contents: 'export default "";', loader: 'js' }));
    b.onResolve({ filter: /\.glb\?url$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace('?url', '')), namespace: 'glb' }));
    b.onLoad({ filter: /.*/, namespace: 'glb' }, (a) => ({ contents: readFileSync(a.path), loader: 'dataurl' }));
  },
};

const ui = await esbuild.build({
  entryPoints: ['src/control-ui.ts'], bundle: true, format: 'esm', minify: true, write: false, outdir: 'out',
  platform: 'browser', target: 'es2022', plugins: [glb], logLevel: 'warning',
  external: [], define: { 'import.meta.env.DEV': 'false' },
});
const js = ui.outputFiles.find((f) => f.path.endsWith('.js'));
const css = ui.outputFiles.find((f) => f.path.endsWith('.css'));
const hash = createHash('sha256').update(js.contents).update(css?.contents ?? '').digest('hex').slice(0, 16);
rmSync('dist/control-ui', { recursive: true, force: true });
const dir = `dist/control-ui/${hash}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/index.js`, js.contents);
if (css) writeFileSync(`${dir}/index.css`, css.contents);
console.log('ui', (js.contents.length / 1048576).toFixed(2), 'MiB', css ? `+ css ${css.contents.length} B` : '');

// The script the backend pipes over SSH into the other computers' `node -`, bundled on its own and
// handed to the backend as a string (virtual:remote-script).
const remote = await esbuild.build({
  entryPoints: ['src/remote.ts'], bundle: true, format: 'cjs', platform: 'node', target: 'node20', write: false, minify: true, logLevel: 'warning',
});
const remoteScript = {
  name: 'remote-script',
  setup(b) {
    b.onResolve({ filter: /^virtual:remote-script$/ }, () => ({ path: 'remote-script', namespace: 'remote' }));
    b.onLoad({ filter: /.*/, namespace: 'remote' }, () => ({ contents: `export default ${JSON.stringify(remote.outputFiles[0].text)};`, loader: 'js' }));
  },
};

await esbuild.build({
  entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile: 'dist/index.js',
  external: ['openclaw', 'openclaw/*'], plugins: [remoteScript], logLevel: 'warning',
});

const manifest = JSON.parse(readFileSync('openclaw.plugin.json', 'utf8'));
manifest.controlUi = { entry: `${dir}/index.js`, ...(css ? { styles: [`${dir}/index.css`] } : {}) };
writeFileSync('openclaw.plugin.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('manifest controlUi', manifest.controlUi);
