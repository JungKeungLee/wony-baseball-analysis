from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from uuid import UUID
from pathlib import Path
from app.api.routes import router

app = FastAPI(title="WONY Baseball Analysis", version="0.4.0")
app.include_router(router, prefix="/api")
from app.api.broadcasts import router as broadcast_router
app.include_router(broadcast_router, prefix="/api")
from app.api.modes import router as modes_router
app.include_router(modes_router, prefix='/api')
from app.api.reports import router as reports_router
app.include_router(reports_router, prefix='/api')

@app.get('/demo/analysis/{analysis_id}', include_in_schema=False)
def unified_report(analysis_id: UUID):
    return FileResponse(Path(__file__).resolve().parents[2] / 'frontend-demo' / 'analysis.html')

@app.get('/demo/live', include_in_schema=False)
@app.get('/demo/live/', include_in_schema=False)
def legacy_live():
    return RedirectResponse('/demo/broadcast/?tab=live')

app.mount('/demo', StaticFiles(directory=Path(__file__).resolve().parents[2] / 'frontend-demo', html=True), name='demo')


@app.get('/health')
def health():
    return {"status": "ok"}
