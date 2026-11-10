import { NOT_FOUND_PATHS } from './not-found.js';

// 未知地址不匹配任何资源，已由 not_found_handling: "404-page" 以 404 返回 404.html。
// 这三条路径匹配到那份文件，静态资源会以 200（或 307 到 /404）返回。这里改成 404。
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!NOT_FOUND_PATHS.has(url.pathname)) return env.ASSETS.fetch(request);

    const assetUrl = new URL(request.url);
    assetUrl.pathname = '/404';
    // 不转发条件请求头，避免缓存里的旧 200 被 304 续上。
    const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
    if (asset.status !== 200) return new Response(null, { status: 404, statusText: 'Not Found' });

    const headers = new Headers(asset.headers);
    if (request.method === 'HEAD') headers.delete('content-length');
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      status: 404,
      statusText: 'Not Found',
      headers,
    });
  },
};
