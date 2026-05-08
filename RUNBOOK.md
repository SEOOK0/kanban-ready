# RUNBOOK

운영 중 자주 일어날 일 두 가지에 대한 절차서. 한 번 보면 충분.

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

## 그 외 알아두면 좋은 것

| 명령 | 용도 |
|---|---|
| `npx wrangler tail` | 실시간 worker 로그 (디버깅용) |
| `npx wrangler d1 execute DB --remote --command="SELECT count(*) FROM cards"` | 임의 SQL 즉석 실행 |
| `npx wrangler deployments list` | 배포 이력 |
| `npx wrangler rollback` | 이전 버전으로 즉시 롤백 |

문제 생기면 위 명령들로 진단 가능.
