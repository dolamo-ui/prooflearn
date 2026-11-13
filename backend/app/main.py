"""ProofLearn backend: FastAPI. Start it with:  uvicorn app.main:app --reload --port 8000"""
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import env
from .errors import AppError
from .routes import agent, assist, coach, colleague, extract, notes, search, study, work

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("prooflearn")

production = env("APP_ENV").lower() == "production"
app = FastAPI(title="ProofLearn API", version="15.0", docs_url=None if production else "/docs", redoc_url=None, openapi_url=None if production else "/openapi.json")

for module in (notes, work, study, agent, assist, extract, search, colleague, coach):
    app.include_router(module.router)


@app.exception_handler(AppError)
async def app_error(_: Request, e: AppError):
    """Only AppError messages are ever shown to the browser."""
    body: dict = {"error": e.message}
    if e.retry_after is not None:
        body["retryAfter"] = e.retry_after
    if e.show_code and e.code:
        body["code"] = e.code
    return JSONResponse(body, status_code=e.status)


@app.exception_handler(Exception)
async def unexpected(request: Request, e: Exception):
    log.exception("[%s] unexpected error", request.url.path)  # detail stays on the server
    return JSONResponse({"error": "Something went wrong. Please try again."}, status_code=500)


@app.get("/api/health")
async def health():
    return {"ok": True}
