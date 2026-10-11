# Windows에서 독립 데모 실행

현재 Codex Cloud 온보딩 세션에는 외부 포트 preview URL 발급 도구가 없고 웹 미리보기가 지원되지 않습니다. 클라우드의 localhost와 PC의 localhost는 다른 컴퓨터입니다. 환경 구성 게시도 웹 서비스 공개 배포가 아닙니다.

GitHub 저장소를 clone하여 실행할 수 있습니다. 제공된 ZIP도 대안으로 사용할 수 있습니다.

## 1. Python 3.12와 FFmpeg 설치

Windows PowerShell에서:

```powershell
winget install --id Python.Python.3.12 --exact
winget install --id Gyan.FFmpeg --exact
```

설치 후 PowerShell을 새로 열어 PATH 변경을 반영하세요. 이미 설치되어 있으면 중복 설치할 필요가 없습니다.

```powershell
py -3.12 --version
ffmpeg -version
ffprobe -version
```

winget이 없으면 Python 공식 Windows 설치 프로그램과 FFmpeg 공식 다운로드 페이지의 Windows 빌드를 사용하세요. Python 3.12와 FFmpeg bin 디렉터리가 PATH에 등록되어야 합니다. FFmpeg는 libx264 인코더가 필요합니다.

## 2. 저장소 clone

Git이 설치된 PowerShell에서:

```powershell
git clone --branch main https://github.com/JungKeungLee/wony-baseball-analysis.git
cd .\wony-baseball-analysis
```

Git이 없으면 `winget install --id Git.Git --exact`로 설치하고 새 PowerShell을 여세요.

### ZIP 사용 대안

다운로드한 ZIP이 있는 폴더에서:

```powershell
Expand-Archive .\wony-baseball-analysis-windows.zip -DestinationPath .\wony-demo
cd .\wony-demo\wony-baseball-analysis
```

ZIP에는 소스, 로컬 Three.js 파일, 문서, 기존 합성 데모 화면 캡처가 포함됩니다. Linux 가상환경, node_modules, Git 메타데이터, 기존 분석 결과와 영상은 포함하지 않았습니다.

## 3. 의존성 설치와 실행

프로젝트 루트에서:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\backend\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

가상환경 활성화가 필요 없어 PowerShell 실행 정책을 변경할 필요도 없습니다. 실행 창을 켜 둔 상태에서 PC 브라우저로 접속하세요:

http://127.0.0.1:8000/demo/

이 주소는 위 명령으로 **PC에서 서버를 실행한 뒤** 사용할 수 있습니다. 클라우드 서버에 연결하는 주소가 아닙니다. 합성 데모 보기 버튼을 누르거나 영상을 업로드하세요. 프론트 빌드/Node.js/CDN은 실행에 필요하지 않습니다.

API 문서: http://127.0.0.1:8000/docs

## 4. 테스트 (선택)

별도 PowerShell에서 프로젝트 루트로 이동한 뒤:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

이 프로젝트는 클라우드 Linux/Python 3.12에서 검증했으며 실제 Windows 실행은 아직 검증하지 않았습니다. 이 ZIP은 독립 프로젝트이고 WONY PHONE을 수정하지 않습니다. 3D와 단계 판정의 한계는 HANDOFF.md를 참고하세요.

## 접속이 안 될 때

- 서버 실행 창의 `Uvicorn running` 메시지와 오류를 먼저 확인하세요.
- 8000 포트가 사용 중이면 명령의 포트를 8001로 바꾸고 브라우저에서도 8001을 사용하세요.
- `py`가 없으면 설치한 Python 3.12의 python.exe 전체 경로로 실행하세요. 다른 Python 버전으로 대신 설치하지 마세요.
- `ffmpeg` 또는 `ffprobe`가 없으면 bin 폴더를 PATH에 추가하고 터미널을 다시 여세요.
