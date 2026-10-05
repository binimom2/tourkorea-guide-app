// tourkorea.biz 는 예약 사이트(골프)만. 수배서·가이드앱 등은 pages.dev 같은 경로로 넘긴다.
// 손님 사이트는 주소창에 tourkorea.biz 만 보이게 / 에서 바로 보여준다(파일은 /golf/site/ 그대로).
const SITE_HOSTS = ['tourkorea.biz', 'www.tourkorea.biz'];
const MAIN = 'https://tourkorea-guide-app.pages.dev';
const ALLOW = ['/golf/', '/api/', '/forms/', '/ovguard.js', '/favicon'];

export async function onRequest({ request, next, env }) {
  const url = new URL(request.url);
  if (!SITE_HOSTS.includes(url.hostname)) return next();

  if (url.hostname === 'www.tourkorea.biz') {
    url.hostname = 'tourkorea.biz';
    return Response.redirect(url.toString(), 301);
  }

  const p = url.pathname;
  // 손님 사이트 본문 — 주소는 / 그대로 두고 /golf/site/ 내용을 보여준다
  if (p === '/' || p === '/index.html') {
    return env.ASSETS.fetch(new Request(url.origin + '/golf/site/', request));
  }
  // 옛 주소로 들어오면 깔끔한 주소로
  if (p === '/golf/site/' || p === '/golf/site/index.html' || p === '/golf/site') {
    return Response.redirect(url.origin + '/' + url.search, 301);
  }
  // 손님 사이트가 상대 경로로 부르는 파일들
  if (p === '/data.js' || p.startsWith('/img/')) {
    return env.ASSETS.fetch(new Request(url.origin + '/golf/site' + p + url.search, request));
  }
  if (p === '/admin' || p.startsWith('/admin/')) {
    return Response.redirect(url.origin + '/golf/site' + p + url.search, 302);
  }
  if (ALLOW.some(a => p === a.replace(/\/$/, '') || p.startsWith(a))) return next();

  return Response.redirect(MAIN + p + url.search, 302);
}
