"""One job: run a web search for the digital colleague and return a few short, cleaned results."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..inputs import text
from ..search import search_enabled, web_search
from ..security import guard, read_json

router = APIRouter()


@router.post("/api/search")
async def search(request: Request):
    guard(request, "search")
    if not search_enabled():
        return JSONResponse({"error": "Web search is not set up yet. Add TAVILY_API_KEY to backend/.env and restart the backend."}, status_code=503)
    b = await read_json(request)
    query = text(b.get("query"), "The search", min=3, max=150)
    return {"hits": await web_search(query)}
