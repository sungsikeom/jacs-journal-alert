# JACS Journal Alert

Journal of the American Chemical Society에 새로 등록된 논문을 DOI 기준으로 확인하는 정적 웹사이트입니다. 논문 제목과 DOI, 공식 DOI 링크만 표시하며 초록과 본문은 수집하지 않습니다.

## 동작 방식

1. GitHub Actions가 매일 Asia/Seoul 오전 9시 17분에 실행됩니다.
2. Crossref에서 매년 1월 1일부터 실행 당일까지 출간된 JACS 논문 메타데이터를 모두 조회합니다.
3. 목록은 출간일 내림차순으로 정렬하여 최신 논문을 맨 위에 표시합니다.
4. `data/seen_dois.json`에 없는 DOI를 신규 논문으로 판정합니다.
5. 연도별 첫 실행에서는 해당 연도의 전체 결과를 기준선으로만 저장하고 알림을 만들지 않습니다.
6. 이후 신규 DOI가 있으면 사이트의 NEW 표시를 갱신하고 GitHub Issue를 생성합니다.

## GitHub에서 처음 설정하기

1. 이 폴더의 파일을 새 GitHub 저장소에 올립니다.
2. 저장소의 `Settings → Pages → Build and deployment → Source`를 `GitHub Actions`로 설정합니다.
3. `Actions → Daily JACS update → Run workflow`를 한 번 실행합니다. 이 실행은 기준선 생성용입니다.
4. GitHub 알림을 받으려면 저장소의 `Watch → Custom → Issues`를 활성화합니다.

Crossref의 polite pool 사용을 위해 저장소의 `Settings → Secrets and variables → Actions → Variables`에 `CROSSREF_MAILTO`를 만들고 본인의 이메일 주소를 입력하는 것을 권장합니다. 입력하지 않아도 실행은 가능하지만 연락 가능한 이메일을 제공하는 것이 Crossref 권장 방식입니다.

## 로컬 점검

```bash
python scripts/update_journals.py --fixture tests/fixtures/crossref_sample.json
python -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 엽니다. 실제 기준선을 만들기 전에는 테스트 후 `data/articles.json`과 `data/seen_dois.json`을 원래 초기값으로 되돌려야 합니다.

## 저널 추가 위치

나중에 다른 저널을 추가할 때는 `scripts/update_journals.py`의 `JOURNALS` 목록에 저널명, 약칭, ISSN을 추가합니다. 현재는 JACS만 등록되어 있습니다.

## 데이터 출처와 고지

Article metadata are obtained from Crossref. This is an independent literature alert service and is not affiliated with or endorsed by the American Chemical Society. Journal names and article titles belong to their respective owners.
