"""WONY RHYTHM 곡 추가 화면 (로컬 PC 전용, Render 에 올리지 않음).

    python tools/admin_server.py            →  http://127.0.0.1:8001/

MP4 선택 + 곡 제목 → [자동 생성] → 영상+4레인 미리보기 → [저장]
저장하면 frontend-demo/ 아래 파일과 songs.json 이 바뀐다. 그 뒤 git 에 커밋/배포해야 Render 사이트에 나온다.

운영 서버(backend/app/main.py)는 이 파일과 분석 모듈(numpy 등)을 import 하지 않는다.
Render 는 디스크가 재배포 때 초기화되고 메모리가 512MB 라서, 업로드/분석을 운영 서버에서 하지 않는다.
"""
import argparse
import contextlib
import json
import secrets
import shutil
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

import import_song  # noqa: E402
import song_store  # noqa: E402

HERE = Path(__file__).resolve().parent
STAGE_ID_CHARS = set('0123456789abcdef-')


def create_app(paths=None, staging=song_store.STAGING):
    paths = paths or song_store.Paths()
    staging = Path(staging)
    uploads = staging / '_uploads'
    app = FastAPI(title='WONY RHYTHM 곡 추가 (로컬)', docs_url=None, redoc_url=None, openapi_url=None)
    jobs = {}
    busy = threading.Lock()

    def stage_dir(stage_id):
        if not stage_id or not set(stage_id) <= STAGE_ID_CHARS or stage_id.startswith('_'):
            raise HTTPException(404, '잘못된 미리보기 ID 입니다.')
        path = staging / stage_id
        if not (path / 'stage.json').is_file():
            raise HTTPException(404, '미리보기가 없습니다 (이미 저장했거나 취소했을 수 있습니다).')
        return path

    def run_job(job_id, video, title, artist, cover, workdir):
        job = jobs[job_id]
        try:
            def progress(step, msg=''):
                job.update(step=step, detail=msg)
            stage, manifest = import_song.stage_song(video, title, artist=artist, cover=cover, paths=paths,
                                                     staging=staging, progress=progress)
            job.update(status='ready', stage=stage.name, manifest=manifest, step='완료', detail='')
        except import_song.ImportFailed as exc:
            job.update(status='failed', error=str(exc))
        except Exception as exc:  # noqa: BLE001
            job.update(status='failed', error=f'알 수 없는 오류: {exc}')
        finally:
            shutil.rmtree(workdir, ignore_errors=True)  # 업로드 사본 정리 (사용자 원본 파일은 건드리지 않음)
            busy.release()

    @app.get('/')
    def index():
        return FileResponse(HERE / 'admin' / 'index.html', headers={'Cache-Control': 'no-cache'})

    @app.get('/game')
    def game():
        return FileResponse(paths.site / 'game.html', headers={'Cache-Control': 'no-cache'})

    @app.post('/api/import')
    async def start_import(video: UploadFile = File(...), title: str = Form(...), artist: str = Form('WONY'),
                           cover: UploadFile | None = File(None)):
        if not title.strip():
            raise HTTPException(400, '곡 제목을 입력해주세요.')
        if not busy.acquire(blocking=False):
            raise HTTPException(409, '다른 곡을 분석하는 중입니다. 끝난 뒤 다시 시도하세요.')
        try:
            job_id = secrets.token_hex(6)
            workdir = uploads / job_id
            workdir.mkdir(parents=True)
            name = Path(video.filename or 'video.mp4').name
            video_path = workdir / ('source' + (Path(name).suffix.lower() or '.mp4'))
            with open(video_path, 'wb') as fh:
                while chunk := await video.read(4 * 1024 * 1024):
                    fh.write(chunk)
            cover_path = None
            if cover is not None and cover.filename:
                cover_path = workdir / ('cover' + (Path(cover.filename).suffix.lower() or '.png'))
                cover_path.write_bytes(await cover.read())
            jobs[job_id] = {'status': 'working', 'step': '업로드 완료', 'detail': name, 'title': title}
            threading.Thread(target=run_job, args=(job_id, video_path, title, artist, cover_path, workdir),
                             daemon=True).start()
        except Exception:
            busy.release()
            raise
        return {'job': job_id}

    @app.get('/api/import/{job_id}')
    def job_status(job_id: str):
        if job_id not in jobs:
            raise HTTPException(404, '작업이 없습니다.')
        return jobs[job_id]

    @app.get('/api/stages')
    def list_stages():
        out = []
        for manifest in sorted(staging.glob('*/stage.json')):
            with contextlib.suppress(Exception):
                data = json.loads(manifest.read_text(encoding='utf-8'))
                if data.get('status') == 'ready':
                    out.append(data)
        return out

    @app.post('/api/stages/{stage_id}/commit')
    def commit(stage_id: str):
        path = stage_dir(stage_id)
        try:
            entry = song_store.commit_stage(path, paths, staging)
        except song_store.StoreError as exc:
            raise HTTPException(400, str(exc)) from exc
        return entry

    @app.post('/api/stages/{stage_id}/discard')
    def discard(stage_id: str):
        song_store.discard_stage(stage_dir(stage_id))
        return {'ok': True}

    @app.get('/api/songs')
    def songs():
        return song_store.load_catalog(paths)

    @app.get('/staging/{stage_id}/{file_path:path}')
    def staged_file(stage_id: str, file_path: str):
        root = stage_dir(stage_id).resolve()
        target = (root / file_path).resolve()
        if root not in target.parents or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target, headers={'Cache-Control': 'no-store'})

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return JSONResponse({'detail': exc.detail}, status_code=exc.status_code)

    for name in ('css', 'js', 'songs', 'assets'):
        (paths.site / name).mkdir(parents=True, exist_ok=True)
        app.mount(f'/{name}', StaticFiles(directory=paths.site / name), name=name)
    return app


def main():
    p = argparse.ArgumentParser(description='WONY RHYTHM 곡 추가 화면 (로컬 전용)')
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8001)
    args = p.parse_args()
    import uvicorn
    print(f'곡 추가 화면: http://{args.host}:{args.port}/')
    uvicorn.run(create_app(), host=args.host, port=args.port)


if __name__ == '__main__':
    main()
