import logging
import httpx
from backend.config import settings

logger = logging.getLogger(__name__)


class LLMError(Exception): pass


async def chat(data: dict, profile: dict | None = None) -> tuple[str, dict]:
    endpoint = profile["endpoint"] if profile else settings.llm_api_base_url
    key = profile["api_key"] if profile else settings.llm_api_key
    timeout = profile["timeout_seconds"] if profile else 120
    url = endpoint.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    logger.info("Sending OpenAI-compatible sampling overrides: %s", {name: data[name] for name in ("temperature", "top_p", "top_k", "min_p", "repetition_penalty", "presence_penalty", "frequency_penalty", "max_tokens") if name in data})
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, json=data, headers=headers)
            response.raise_for_status()
            body = response.json()
        return body["choices"][0]["message"]["content"], body.get("usage") or {}
    except (httpx.HTTPError, KeyError, IndexError, TypeError) as error:
        raise LLMError(f"LLM request failed: {error}") from error
