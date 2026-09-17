여행사 회원(B2B) — 첫 승인 전에 꼭 실행할 Supabase 권한 정책   (사장님 2026-09-17)
=====================================================================

■ 왜 필요한가
   여행사 계정은 직원용과 같은 Supabase 프로젝트에 만들어집니다.
   지금 정책(authenticated_all)은 「로그인한 사람은 전부 읽고 쓸 수 있다」라서,
   그대로 두면 여행사 계정도 예약관리·정산서 자료까지 읽을 수 있습니다.
   아래 정책은 여행사 계정(kind = 'agency')을 직원 정책에서 빼고,
   «승인된» 여행사만 요금표·코드·사이트 내용 세 줄을 «읽기만» 하게 합니다.

■ 실행 — Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 실행 (한 번만)
   ---------------------------------------------------------------
   -- 1) 직원 정책: 여행사 계정은 제외
   drop policy if exists authenticated_all on public.guide_data;
   drop policy if exists staff_all on public.guide_data;
   create policy staff_all on public.guide_data
     for all to authenticated
     using     (coalesce(auth.jwt() -> 'user_metadata' ->> 'kind', '') <> 'agency')
     with check(coalesce(auth.jwt() -> 'user_metadata' ->> 'kind', '') <> 'agency');

   -- 2) 승인된 여행사: 요금표·코드·사이트 내용만 읽기
   drop policy if exists agency_read on public.guide_data;
   create policy agency_read on public.guide_data
     for select to authenticated
     using (
       auth.jwt() -> 'user_metadata' ->> 'kind' = 'agency'
       and coalesce(auth.jwt() -> 'user_metadata' ->> 'approved', 'false') = 'true'
       and data_key in ('golf_pricing', 'golf_codes', 'golf_site')
     );
   ---------------------------------------------------------------

■ 확인 방법
   · 직원 로그인(예약관리·가이드정산서·골프 관리)이 전과 똑같이 되면 1)이 맞게 들어간 것.
   · 여행사 테스트 아이디를 승인한 뒤, 그 아이디로 사이트에 로그인해 「실시간 견적」이 열리면 2)가 된 것.
   · 승인 전 아이디로는 실시간 견적이 안 열려야 정상.

■ 흐름 정리
   손님 사이트 「여행사 로그인 → 여행사 가입 신청」(아이디·비밀번호·여행사명·담당자·연락처·명함 사진)
   → 관리 화면(/golf/site/admin/) 「🏢 여행사 회원」 탭에 「대기」로 들어옴 → 명함 보고 [✔ 승인]
   → 여행사가 같은 아이디로 로그인 → 「실시간 견적」이 바로 열림(별도 단계 없음)
   · 레벨은 하나. 특정 여행사만 마진을 달리 주려면 「마진 예외」 칸에 밧 숫자를 적는다(비우면 기본).
   · 거절·정지하면 그 아이디는 실시간 견적을 못 연다. 삭제는 어드민만(계정·명함·기록 전부).
   · 여행사 로그인 아이디는 내부적으로 <아이디>@agency.tourkorea.biz 이메일로 만들어진다(메일은 안 보낸다).

■ 참고 — 로그인 없이 여는 테스트 정책(README-실시간견적-비로그인테스트.txt)을 열어 두었다면
   회원제가 자리 잡은 뒤 그 정책은 지우는 것이 맞다(drop policy "golf 요금표 공개 읽기(테스트)" …).
