import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://relyless.elazer.wang',
  trailingSlash: 'never',
  build: { format: 'file' },
  // 隐私政策与版本号直接读仓库根目录的文件，官网不保存副本。
  vite: { server: { fs: { allow: ['..'] } } },
});
