# JACS & Science Journal Alert

Journal of the American Chemical Society와 Science Research Articles를 DOI 기준으로 확인하는 정적 웹사이트입니다. 논문 제목과 DOI, 공식 DOI 링크만 표시하며 초록과 본문은 수집하지 않습니다.

사이트에서는 전체 논문과 이번 실행에서 새로 발견된 논문을 구분해 볼 수 있고, 제목·DOI 검색과 50편 단위 더 보기를 지원합니다.

## 동작 방식

1. GitHub Actions가 매일 Asia/Seoul 오전 9시 17분에 실행됩니다.
2. GitHub Actions는 Crossref의 JACS 메타데이터와 로컬 Chrome에서 검증한 ACS·Science 목록을 병합합니다.
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

## ACS 공식 목록을 사용하는 Windows 로컬 수집

ACS 검색 페이지는 GitHub Actions의 데이터센터 요청을 차단할 수 있습니다. `scripts/collect_acs.mjs`는 사용자 Windows PC의 실제 Google Chrome과 전용 프로필을 사용하여 2026년 1월 1일 경계까지 검색 결과를 순회합니다. ACS DOI 목록과 Crossref DOI 목록의 합집합을 사용하므로 어느 한쪽에만 먼저 등록된 논문도 보존하며, 제목과 날짜는 Crossref 메타데이터로 보완합니다.

최초 1회 PowerShell에서 다음을 실행합니다.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install_windows_task.ps1
.\scripts\run_local_acs_update.ps1
```

첫 수동 실행이 성공하면 Windows 작업 스케줄러의 `JACS Journal Alert ACS Update`가 매일 오전 9시 30분 실행됩니다. PC가 꺼져 있었으면 다음 시작 시 실행됩니다. Chrome에 CAPTCHA나 접근 차단이 나타나거나 2026년 1월 1일까지 도달하지 못하면 데이터 파일과 GitHub 저장소를 변경하지 않습니다. 실패 화면과 HTML은 로컬 `diagnostics` 폴더에만 저장됩니다.

## Science Research Articles 수집

`extension` 폴더를 Chrome 확장 프로그램으로 한 번 로드한 뒤 다음 명령을 실행하면 Science 목차를 순회하고 `data/science_articles.json`을 갱신합니다.

```powershell
npm run collect:science
```

사이트 데이터는 다음 명령으로 JACS와 Science 목록을 함께 생성합니다.

```powershell
py -3 scripts\update_journals.py --acs-file data\acs_articles.json --science-file data\science_articles.json
```

## 로컬 점검

```bash
python scripts/update_journals.py --fixture tests/fixtures/crossref_sample.json
python -m unittest discover -s tests
python -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 엽니다. 실제 기준선을 만들기 전에는 테스트 후 `data/articles.json`과 `data/seen_dois.json`을 원래 초기값으로 되돌려야 합니다.

## 저널 추가 위치

Crossref 기반 저널은 `scripts/update_journals.py`의 `JOURNALS` 목록에 저널명, 약칭, ISSN을 추가합니다. 출판사 페이지로 검증하는 저널은 해당 로더와 수집기를 함께 추가합니다.

## 데이터 출처와 고지

Article inclusion can be verified from ACS JACS search results and Science tables of contents collected in a user's local Chrome, while JACS metadata are supplemented from Crossref. This is an independent literature alert service and is not affiliated with or endorsed by the American Chemical Society or AAAS. Journal names and article titles belong to their respective owners.
