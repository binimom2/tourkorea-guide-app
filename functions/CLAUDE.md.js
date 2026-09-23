/* 작업 안내 파일(CLAUDE.md)은 웹에 내보내지 않는다 — 정적 파일보다 함수가 먼저 받는다 */
export const onRequest = () => new Response('Not found', { status: 404 });
