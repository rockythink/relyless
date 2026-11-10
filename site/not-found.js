// /404 是 404.html 这份真实资源。静态资源的 html_handling 会把它当成普通页面。
export const NOT_FOUND_PATHS = new Set(['/404', '/404/', '/404.html']);

function isNotFoundPathname(pathname) {
  return NOT_FOUND_PATHS.has(pathname);
}

export function isNotFoundLocation(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return isNotFoundPathname(new URL(value).pathname);
  } catch {
    return isNotFoundPathname(value);
  }
}
