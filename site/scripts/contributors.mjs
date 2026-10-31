// 从 GitHub 拉取贡献者名单并把头像存进站点，构建时不再联网，访客也不会向 GitHub 发请求。
// 有新贡献者时运行 `npm run contributors`，提交生成的文件后重新部署。
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repo = 'rockythink/relyless';
const root = fileURLToPath(new URL('..', import.meta.url));
const avatarDir = `${root}public/contributors/`;
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'relyless-site' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function api(path) {
  const response = await fetch(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  return response.json();
}

const list = (await api(`repos/${repo}/contributors?per_page=100`)).filter(item => item.type === 'User');
if (!list.length) throw new Error('GitHub returned no contributors; keeping the existing list.');

await mkdir(avatarDir, { recursive: true });
const contributors = [];
for (const item of list) {
  const user = await api(`users/${item.login}`);
  const avatar = await fetch(`${item.avatar_url}&s=128`, { signal: AbortSignal.timeout(15000) });
  if (!avatar.ok) throw new Error(`Avatar for ${item.login}: HTTP ${avatar.status}`);
  const type = avatar.headers.get('content-type') || '';
  const file = `${item.login.toLowerCase()}.${type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png'}`;
  await writeFile(avatarDir + file, Buffer.from(await avatar.arrayBuffer()));
  contributors.push({ login: item.login, name: user.name || item.login, url: user.html_url, avatar: `/contributors/${file}` });
}

// 清掉已不在名单里的旧头像。
const keep = new Set(contributors.map(item => item.avatar.split('/').pop()));
for (const file of await readdir(avatarDir)) if (!keep.has(file)) await rm(avatarDir + file);

await writeFile(`${root}src/contributors.json`, JSON.stringify(contributors, null, 2) + '\n');
console.log(`Saved ${contributors.length} contributors: ${contributors.map(item => item.login).join(', ')}`);
