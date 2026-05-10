# Operations

운영 중 자주 일어날 일들에 대한 절차서: IP 차단 복구, D1 백업/복구, 스키마 마이그레이션. 한 번 보면 충분.

---

## 1. 본인이 차단당했을 때 (집 IP 변경)

가장 흔한 케이스. 한국 ISP 대부분 동적 IP라 **라우터 재시작 / 정전 / ISP 갱신** 시 집 IP가 바뀝니다. 그러면 본인도 WAF에 막혀 1020 페이지가 뜸.

### 증상

- https://kanban.example.com 접속 시 Cloudflare 1020 (Access Denied) 페이지
- `curl https://kanban.example.com/api/health` → block 응답

### 복구 (3분)

> 대시보드 자체는 IP 제한 없음. 모바일 4G에서도 접속됩니다.

1. 새 IP 확인:
   ```bash
   curl ifconfig.me; echo
   curl -6 ifconfig.me; echo   # IPv6 (있는 경우)
   ```

2. https://dash.cloudflare.com → **Websites → example.com** → **Security → WAF → Custom rules**

3. `kanban home only` rule → **Edit**

4. Expression의 IP를 새 IP로 교체:
   ```
   (http.host eq "kanban.example.com") and not (ip.src in {새IP})
   ```

5. **Save and Deploy**

### 급하게 우회만 하고 싶을 때

같은 화면에서 rule 옆 **토글 OFF** → 즉시 모든 IP 통과 (= 보안 일시 해제). 작업 끝나면 IP 갱신 후 다시 ON.

---

## 2. D1 데이터 백업 / 복구

지금은 백업이 없음. 카드 손실 시 복구 불가. **수동 백업 명령으로 충분** (자기만 쓰는 데이터라 자동화는 over-engineering).

### 백업 (한 줄)

```bash
npx wrangler d1 export DB --remote --output=backup-$(date +%Y%m%d).sql
```

→ 프로젝트 루트에 `backup-20260508.sql` 같은 파일 생성. 이걸 git에 커밋하지 마시고 (개인 데이터), 별도 디렉토리나 외장 디스크에 보관.

### 권장 주기

- **주 1회** 정도 (개인 사용이면 충분)
- 큰 변화 직전 (스키마 변경, 대량 카드 정리 등)

### 복구

만약 데이터가 사라지거나 망가진 경우:

```bash
# 1. (위험할 경우) 현재 DB 일단 export로 백업
npx wrangler d1 export DB --remote --output=before-restore-$(date +%Y%m%d).sql

# 2. 백업 파일로 복구
npx wrangler d1 execute DB --remote --file=backup-20260508.sql
```

> **주의**: `execute --file`은 SQL을 그대로 실행. 기존 테이블이 있으면 `CREATE TABLE` 충돌 날 수 있음. 필요하면 `DROP TABLE cards;` 먼저 한 줄 실행 후 import.

### 로컬 D1로 복원 테스트

remote에 적용 전 로컬에서 한 번 검증 가능:

```bash
npx wrangler d1 execute DB --local --file=backup-20260508.sql
npx wrangler dev
# 로컬 :8787에서 카드 잘 보이는지 확인
```

---

## 3. 스키마 마이그레이션 + 롤백 플랜

`migrations/000N_*.sql`을 추가해 D1 스키마를 바꿀 때 따르는 절차. **DB와 worker 코드는 한 쌍**이라 둘을 동시에 맞춰야 함.

### 표준 배포 순서 (이걸로 거의 다 끝남)

```bash
# 0) 코드 커밋 & main 머지부터. 더티 워크트리에서 deploy 금지 (소스 유실 위험)
git add -p && git commit
git -C <main-repo-root> merge --ff-only <branch>
git -C <main-repo-root> push origin main

# 1) 원격 스냅샷 (롤백용)
npx wrangler d1 export DB --remote --output=backup-pre-000N.sql

# 2) 로컬 검증 (data import 후 migrate)
npx wrangler d1 execute DB --local --file=backup-pre-000N.sql   # 필요 시
npm run db:migrate:local
npm run dev:worker   # 카드 read/write/move 모두 확인

# 3) 원격 적용 (DB → 코드 순서. 거꾸로 하면 새 worker가 없는 컬럼 조회해서 5xx)
npm run db:migrate:remote
npm run deploy

# 4) 헬스체크
curl https://kanban.example.com/api/health
curl https://kanban.example.com/api/cards | jq '.cards | length'
```

### 위험 신호 vs 정상 신호

| 상황 | 정상 / 비정상 |
|---|---|
| `db:migrate:remote`가 0건 적용 | 이미 적용됨, 정상 |
| `db:migrate:remote` 후 `/api/cards` 가 5xx | 비정상 (롤백) |
| 새 컬럼이 NULL/0으로만 채워짐 | 마이그레이션의 백필 SQL 누락 (재작성 필요) |

### 롤백 절차 (배포 후 문제 발견 시)

**증상별 대응**:

**A. Worker 코드만 문제, DB는 멀쩡** → worker 롤백만:
```bash
npx wrangler rollback   # 직전 버전으로
```

**B. 마이그레이션이 데이터를 망가뜨렸음** → DB 복원 + worker 롤백:
```bash
# 1) worker 먼저 이전 버전으로 (새 DB 형태에 의존하면 안 되므로)
npx wrangler rollback

# 2) 현재 망가진 DB도 일단 export (포렌식용)
npx wrangler d1 export DB --remote --output=broken-$(date +%Y%m%d-%H%M).sql

# 3) 사용자 테이블 + 마이그레이션 기록 드롭
npx wrangler d1 execute DB --remote --command \
  "DROP TABLE IF EXISTS cards; DROP TABLE IF EXISTS d1_migrations;"

# 4) 백업 파일로 복원 (CREATE TABLE + INSERT 다 포함)
npx wrangler d1 execute DB --remote --file=backup-pre-000N.sql

# 5) 검증
curl https://kanban.example.com/api/cards | jq '.cards | length'
```

**C. main에 머지된 코드도 되돌려야 함** → revert 커밋:
```bash
git revert <bad-commit>
git push origin main
# 다음 deploy까지 main과 운영이 다시 동기화됨
```

### 마이그레이션 작성 시 체크리스트

- [ ] **idempotent하게**: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`
- [ ] **NOT NULL 컬럼 추가 시 백필 SQL 포함**: `ROW_NUMBER()` 등으로 기존 행 채우기
- [ ] **CHECK 제약 변경 시 테이블 재구축**: SQLite는 ALTER로 CHECK 못 바꿈 (0002, 0003 참고)
- [ ] **로컬에서 main DB 사본으로 먼저 검증**: 운영 데이터 형태가 로컬과 다를 수 있음
- [ ] **worker 코드와 같은 PR/커밋에 묶기**: DB와 코드 분리 배포 금지

### 백업 파일 보관 정책

- `backup-*.sql`은 `.gitignore`에 등록되어 있음 (커밋 금지)
- 마이그레이션 직전 백업은 최소 1주일은 보관 (개인 외장 디스크 또는 별도 디렉토리)
- 운영 안정 확인 후 폐기

---

## 그 외 알아두면 좋은 것

| 명령 | 용도 |
|---|---|
| `npx wrangler tail` | 실시간 worker 로그 (디버깅용) |
| `npx wrangler d1 execute DB --remote --command="SELECT count(*) FROM cards"` | 임의 SQL 즉석 실행 |
| `npx wrangler deployments list` | 배포 이력 |
| `npx wrangler rollback` | 이전 버전으로 즉시 롤백 |

문제 생기면 위 명령들로 진단 가능.
