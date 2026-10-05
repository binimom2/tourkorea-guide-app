// tourkorea.biz 는 예약 사이트(골프)만. 수배서·가이드앱 등은 pages.dev 같은 경로로 넘긴다.
const SITE_HOSTS = ['tourkorea.biz', 'www.tourkorea.biz'];
const MAIN = 'https://tourkorea-guide-app.pages.dev';
const ALLOW = ['/golf/', '/api/', '/forms/', '/ovguard.js', '/favicon'];

export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (!SITE_HOSTS.includes(url.hostname)) return next();

  if (url.hostname === 'www.tourkorea.biz') {
    url.hostname = 'tourkorea.biz';
    return Response.redirect(url.toString(), 301);
  }

  const p = url.pathname;
  if (p === '/' || p === '/index.html') {
    return Response.redirect(url.origin + '/golf/site/' + url.search, 302);
  }
  if (ALLOW.some(a => p === a.replace(/\/$/, '') || p.startsWith(a))) return next();

  return Response.redirect(MAIN + p + url.search, 302);
}
