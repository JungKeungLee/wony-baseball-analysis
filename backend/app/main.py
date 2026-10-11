from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from app.api.routes import router

app = FastAPI(title="WONY Baseball Analysis", version="0.4.0")
app.include_router(router, prefix="/api")
app.mount('/demo', StaticFiles(directory=Path(__file__).resolve().parents[2] / 'frontend-demo', html=True), name='demo')


@app.get('/health')
def health():
    return {"status": "ok"}
