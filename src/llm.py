"""Optional LLM briefing. First configured provider wins unless LLM_PROVIDER is set.

Supported API keys (not consumer chat subscriptions):

- ANTHROPIC_API_KEY — Claude, from console.anthropic.com
- OPENAI_API_KEY — OpenAI, from platform.openai.com (optional OPENAI_BASE_URL)
- GEMINI_API_KEY — Google AI Studio
- CURSOR_API_KEY — only if CURSOR_BASE_URL is an OpenAI-compatible chat endpoint

Claude.ai Pro, ChatGPT Plus, and a Cursor IDE subscription do not mint these keys.
Cursor's official API is Cloud Agents, not chat completions.
"""

from __future__ import annotations

import os
from typing import Callable

import requests

from .jobs import USER_AGENT

_TIMEOUT = 90


def _strip(value: str | None) -> str:
    return (value or "").strip()


def cursor_key() -> str:
    return _strip(os.getenv("CURSOR_API_KEY"))


def anthropic_key() -> str:
    return _strip(os.getenv("ANTHROPIC_API_KEY") or os.getenv("CLAUDE_API_KEY"))


def openai_key() -> str:
    return _strip(os.getenv("OPENAI_API_KEY"))


def gemini_key() -> str:
    return _strip(os.getenv("GEMINI_API_KEY"))


def cursor_chat_url() -> str:
    """OpenAI-compatible chat URL. Empty unless CURSOR_BASE_URL is set."""
    base = _strip(os.getenv("CURSOR_BASE_URL")).rstrip("/")
    if not base:
        return ""
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def has_llm_key() -> bool:
    return bool(anthropic_key() or openai_key() or gemini_key() or (cursor_key() and cursor_chat_url()))


def cursor_needs_chat_gateway() -> bool:
    """True when a Cursor key is present but there is no chat endpoint to call."""
    return bool(cursor_key() and not cursor_chat_url() and not anthropic_key() and not openai_key() and not gemini_key())


def active_provider() -> str | None:
    """Provider that complete() will call. LLM_PROVIDER overrides auto-detect."""
    forced = _strip(os.getenv("LLM_PROVIDER")).lower()
    if forced:
        mapping = {
            "cursor": bool(cursor_key() and cursor_chat_url()),
            "anthropic": bool(anthropic_key()),
            "claude": bool(anthropic_key()),
            "openai": bool(openai_key()),
            "gemini": bool(gemini_key()),
            "google": bool(gemini_key()),
        }
        return forced if mapping.get(forced) else None
    if cursor_key() and cursor_chat_url():
        return "cursor"
    if anthropic_key():
        return "anthropic"
    if openai_key():
        return "openai"
    if gemini_key():
        return "gemini"
    return None


def _openai_compat(prompt: str, *, api_key: str, url: str, model: str, extra_headers: dict | None = None) -> str:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }
    if extra_headers:
        headers.update(extra_headers)
    resp = requests.post(
        url,
        headers=headers,
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
        },
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _complete_cursor(prompt: str) -> str:
    url = cursor_chat_url()
    if not cursor_key() or not url:
        raise RuntimeError("CURSOR_BASE_URL must point at an OpenAI-compatible /v1/chat/completions endpoint")
    model = _strip(os.getenv("CURSOR_MODEL")) or "composer-2.5"
    return _openai_compat(prompt, api_key=cursor_key(), url=url, model=model)


def _complete_anthropic(prompt: str) -> str:
    model = _strip(os.getenv("ANTHROPIC_MODEL") or os.getenv("CLAUDE_MODEL")) or "claude-sonnet-4-5"
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": anthropic_key(),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "User-Agent": USER_AGENT,
        },
        json={
            "model": model,
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    parts = resp.json().get("content") or []
    texts = [part.get("text") or "" for part in parts if isinstance(part, dict)]
    return "".join(texts).strip()


def _complete_openai(prompt: str) -> str:
    base = _strip(os.getenv("OPENAI_BASE_URL")).rstrip("/") or "https://api.openai.com/v1"
    url = base if base.endswith("/chat/completions") else f"{base}/chat/completions"
    model = _strip(os.getenv("OPENAI_MODEL")) or "gpt-4o-mini"
    return _openai_compat(prompt, api_key=openai_key(), url=url, model=model)


def _complete_gemini(prompt: str) -> str:
    model = _strip(os.getenv("GEMINI_MODEL")) or "gemini-2.0-flash"
    resp = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        params={"key": gemini_key()},
        headers={"User-Agent": USER_AGENT},
        json={"contents": [{"parts": [{"text": prompt}]}]},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()["candidates"][0]["content"]["parts"][0]["text"]


_HANDLERS: dict[str, Callable[[str], str]] = {
    "cursor": _complete_cursor,
    "anthropic": _complete_anthropic,
    "claude": _complete_anthropic,
    "openai": _complete_openai,
    "gemini": _complete_gemini,
    "google": _complete_gemini,
}


def complete(prompt: str) -> str | None:
    """Call the active provider. Returns None when no usable API key is set."""
    name = active_provider()
    if not name:
        return None
    return _HANDLERS[name](prompt)
