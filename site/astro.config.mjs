import { copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

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
      },
    },
  };
}

export default defineConfig({
  site: 'https://relyless.elazer.wang',
  trailingSlash: 'never',
  build: { format: 'file' },
  // publishSitemapXml 必须排在 sitemap() 之后，构建钩子才会看到已写出的文件。
  integrations: [sitemap(), publishSitemapXml()],
  // 隐私政策与版本号直接读仓库根目录的文件，官网不保存副本。
  vite: { server: { fs: { allow: ['..'] } } },
});
