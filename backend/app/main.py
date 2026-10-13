"""WONY RHYTHM: static site + health check + online records (login ticket, result save, ranking).

Gameplay (timing, judgement, scoring, audio) runs entirely in the browser. The server never sees a
note or a frame. Online records are one small request per finished game (app/rhythm), so it still
fits easily in a 512 MB instance.
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.auth.wony_link import install as install_wony_gate
from app.rhythm.config import load_local_env_file
from app.rhythm.routes import create_router as create_rhythm_router

load_local_env_file()  # 로컬 개발: 저장소 루트 .env (있으면). Render 에서는 대시보드 환경변수만 사용

SITE = Path(__file__).resolve().parents[2] / 'frontend-demo'
# Only these top-level entries are public. Anything else in frontend-demo/ (tests, node_modules,
# package.json, leftovers) is never served.
PUBLIC_DIRS = {'css', 'js', 'songs', 'assets'}
PAGES = {'': 'index.html', 'game': 'game.html', 'songs': 'songs.html', 'settings': 'settings.html',
         'scores': 'scores.html', 'ranking': 'ranking.html', 'shop': 'shop.html'}

app = FastAPI(title='WONY RHYTHM', version='1.0.0', docs_url=None, redoc_url=None, openapi_url=None)

# WONY PHONE admin-only entry (enabled when WONY_AUTH_SECRET is set; see app/auth/wony_link.py)
install_wony_gate(app)


@app.get('/health')
def health():
    return {'status': 'ok'}


# WONY PHONE 회원 로그인(1회용 입장권) · 온라인 기록 · 랭킹 (환경변수가 없으면 온라인 기능만 꺼짐)
app.include_router(create_rhythm_router())


def _page(name):
    def serve():
        return FileResponse(SITE / name, headers={'Cache-Control': 'no-cache'})
    return serve


for _path, _file in PAGES.items():
    app.add_api_route(f'/{_path}', _page(_file), methods=['GET'], include_in_schema=False)
    if _path:
        app.add_api_route(f'/{_path}/', _page(_file), methods=['GET'], include_in_schema=False)


@app.get('/demo', include_in_schema=False)
@app.get('/demo/{rest:path}', include_in_schema=False)
def legacy_demo(rest: str = ''):
    """Old analysis URLs (/demo/...) now land on the WONY RHYTHM home."""
    return RedirectResponse('/', status_code=301)


class SiteFiles(StaticFiles):
    def lookup_path(self, path):
        parts = Path(path).parts
        if parts and parts[0] in PUBLIC_DIRS:
            return super().lookup_path(path)
        return '', None


app.mount('/', SiteFiles(directory=SITE), name='site')
