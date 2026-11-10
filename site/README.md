# RelyLess 官网

`https://relyless.elazer.wang` 的源码。Astro 静态站，部署为 Cloudflare Workers 静态资源。它不属于扩展：`npm run release:package` 只打包 `extension/`、`connector/` 等指定路径，不会包含本目录。

## 内容来源

- 隐私政策页直接渲染仓库根目录的 `PRIVACY.md` 与 `PRIVACY.en.md`，不在这里保存副本。改隐私政策只改根目录文件，重新部署即可。
- 页脚版本号读取根目录 `package.json`。
- 截图来自 Chrome 应用商店素材，转为 WebP 放在 `public/screens/`。界面明显变化时一并更新。
- 首页的贡献者名单来自 `src/contributors.json`，头像存在 `public/contributors/`。有新贡献者时运行 `npm run contributors`（从 GitHub API 拉取，可选 `GITHUB_TOKEN`），提交生成的文件后重新部署。名单只列名字和账号，不显示提交数或排名。
- 文案与商店说明遵守同一条规则：不罗列模型服务商或品牌名称。

## 开发与部署

```bash
cd site
npm install
npm run dev        # 本地预览
npm run build      # 输出到 site/dist/
npm run deploy     # 构建并用 wrangler 部署，需要已登录 Cloudflare
```

`wrangler.jsonc` 把 Worker 绑定到自定义域名 `relyless.elazer.wang`，首次部署时由 Cloudflare 创建 DNS 记录和证书。

## 搜索引擎

- `public/robots.txt` 允许所有爬虫，并单独允许 Baiduspider。`Sitemap` 行指向 `https://relyless.elazer.wang/sitemap.xml`。
- `@astrojs/sitemap` 在构建时根据 `site` 生成 `sitemap-index.xml` 和 `sitemap-0.xml`（页面很多时还会有后续分片）。构建结束会把唯一的分页文件复制为 `sitemap.xml`；若分片超过一个，则复制索引文件，保证 `robots.txt` 里的地址存在。
- 首页沿用现有简介，另外输出 `SoftwareApplication` 结构化数据。其中的免费报价对应页面上的「免费开源」，浏览器范围对应常见问题里的 Chrome 与 Edge；不写评分或页面上没有的能力。
- canonical 和 Open Graph 地址去掉构建文件名里的 `.html`，与 sitemap 中的线上路径一致。首页是 `https://relyless.elazer.wang/`。
- 404 页输出 `noindex`，不输出 canonical 和 `og:url`。`@astrojs/sitemap` 不收录路径名为 404 的页面，构建时再排除 `/404` 与 `/404.html`。
- 未知地址由 `not_found_handling: "404-page"` 以 HTTP 404 返回 `404.html`。`/404`、`/404/`、`/404.html` 能匹配到这份文件，静态资源会返回 200 或 307，所以 `worker.js` 只改这三条路径的状态码。
