import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
const paths = ['extension', 'connector', 'README.md', 'PRIVACY.md', 'PRIVACY.en.md', 'LICENSE', 'NOTICE.txt'];

if (git('status', '--porcelain', '--untracked-files=all')) {
  throw new Error('Commit all source changes before packaging. Ignored debug files and dist/ are never included.');
}
const commit = git('rev-parse', 'HEAD');
const manifest = JSON.parse(git('show', `${commit}:extension/manifest.json`));
const pkg = JSON.parse(git('show', `${commit}:package.json`));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || manifest.version !== pkg.version) {
  throw new Error('package.json and extension/manifest.json must have the same release version.');
}
for (const path of [...paths, 'extension/local-inference/runtime/transformers.min.js',
  'extension/local-inference/runtime/ort-wasm-simd-threaded.jsep.mjs',
  'extension/local-inference/runtime/ort-wasm-simd-threaded.jsep.wasm',
  'extension/local-inference/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx']) {
  git('cat-file', '-e', `${commit}:${path}`);
}
const name = `relyless-${pkg.version}`;
const output = join(root, 'dist');
const archive = join(output, `${name}.zip`);
await mkdir(output, {recursive: true});
git('archive', '--format=zip', `--prefix=${name}/`, `--output=${archive}.tmp`, commit, '--', ...paths);
await rename(`${archive}.tmp`, archive);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
await writeFile(join(output, 'SHA256SUMS'), `${hash.digest('hex')}  ${name}.zip\n`);
console.log(`Packaged ${commit}\n${archive}\n${join(output, 'SHA256SUMS')}`);
