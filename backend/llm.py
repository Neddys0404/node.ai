import httpx
from backend.config import settings


class LLMError(Exception): pass


async def chat(data: dict) -> str:
    url = settings.llm_api_base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"} if settings.llm_api_key else {}
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(url, json=data, headers=headers)
            response.raise_for_status()
            body = response.json()
        return body["choices"][0]["message"]["content"]
    except (httpx.HTTPError, KeyError, IndexError, TypeError) as error:
        raise LLMError(f"LLM request failed: {error}") from error
