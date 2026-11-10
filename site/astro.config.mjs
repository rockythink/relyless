import { copyFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { isNotFoundLocation } from './not-found.js';

// @astrojs/sitemap 写出 sitemap-index.xml 和 sitemap-N.xml，不会写 sitemap.xml。
// robots.txt 的 Sitemap 行指向 /sitemap.xml，所以构建后再发布这个入口。
function publishSitemapXml() {
  return {
    name: 'relyless-sitemap-xml',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const destDir = fileURLToPath(dir);
        const names = await readdir(destDir);
        const chunks = names.filter((name) => /^sitemap-\d+\.xml$/.test(name)).sort();
        const source = chunks.length === 1 ? chunks[0] : 'sitemap-index.xml';
        if (!names.includes(source)) {
          throw new Error(`@astrojs/sitemap did not write ${source}`);
        }
        await copyFile(path.join(destDir, source), path.join(destDir, 'sitemap.xml'));
        logger.info(`sitemap.xml copied from ${source}`);
        await assertNotFoundSeo(destDir);
      },
    },
  };
}

function hasNoindex(html) {
  const match = html.match(/<meta\s+name="robots"\s+content="([^"]*)"/i);
  return Boolean(match?.[1].split(',').map((part) => part.trim()).includes('noindex'));
}

// 404.html 会被原样返回给未知地址，也会被 Worker 用在 /404 上。构建期锁住收录信号。
async function assertNotFoundSeo(destDir) {
  const files = await readdir(destDir, { recursive: true });
  const htmlFiles = files.filter((name) => name.endsWith('.html'));
  if (!htmlFiles.includes('404.html')) throw new Error('404.html was not built');

  for (const name of htmlFiles) {
    const html = await readFile(path.join(destDir, name), 'utf8');
    const notFound = name === '404.html';
    if (notFound) {
      if (!hasNoindex(html)) throw new Error('404.html must include a noindex robots meta');
      if (html.includes('rel="canonical"') || html.includes("rel='canonical'")) {
        throw new Error('404.html must not include a canonical link');
      }
      if (html.includes('property="og:url"') || html.includes("property='og:url'")) {
        throw new Error('404.html must not include og:url');
      }
      continue;
    }
    if (hasNoindex(html) || !html.includes('rel="canonical"')) {
      throw new Error(`${name} must keep its canonical link and must not be noindex`);
    }
  }

  const sitemapXml = await readFile(path.join(destDir, 'sitemap.xml'), 'utf8');
  const listed = [...sitemapXml.matchAll(/<loc>([^<]*)<\/loc>/g)]
    .map((match) => match[1])
    .filter((loc) => isNotFoundLocation(loc));
  if (listed.length > 0) throw new Error(`sitemap.xml must not list the 404 page: ${listed.join(', ')}`);
}

export default defineConfig({
  site: 'https://relyless.elazer.wang',
  trailingSlash: 'never',
  build: { format: 'file' },
  // publishSitemapXml 必须排在 sitemap() 之后，构建钩子才会看到已写出的文件。
  // @astrojs/sitemap 会丢掉路径名为 404 的页面。filter 再挡一次 /404.html，避免以后自定义页面把它加回去。
  integrations: [sitemap({ filter: (page) => !isNotFoundLocation(page) }), publishSitemapXml()],
  // 隐私政策与版本号直接读仓库根目录的文件，官网不保存副本。
  vite: { server: { fs: { allow: ['..'] } } },
});
