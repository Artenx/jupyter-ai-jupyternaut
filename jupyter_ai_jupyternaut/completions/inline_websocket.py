"""Authenticated WebSocket endpoint for Jupyternaut inline completions."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from jupyter_server.base.handlers import JupyterHandler
from langchain_core.messages import HumanMessage, SystemMessage
from tornado import web, websocket

from ..jupyternaut.chat_models import ChatLiteLLM
from .utils import (
    MAX_PREFIX_CHARS,
    MAX_SUFFIX_CHARS,
    SYSTEM_PROMPT,
    build_inline_prompt,
    clean_completion,
    extract_message_text,
    resolve_completion_model,
)

_MAX_COMPLETION_TOKENS = 128
_REQUEST_TIMEOUT_SECONDS = 20


class InlineCompletionWebSocketHandler(JupyterHandler, websocket.WebSocketHandler):
    """Generate editor-local code suggestions with the configured JAI model."""

    def initialize(self) -> None:
        self._completion_tasks: set[asyncio.Task] = set()

    def pre_get(self) -> None:
        user = self.current_user
        if user is None:
            self.log.warning("Unauthenticated inline-completion WebSocket")
            raise web.HTTPError(403)
        if not self.authorizer.is_authorized(self, user, "execute", "events"):
            raise web.HTTPError(403)

    async def get(self, *args: Any, **kwargs: Any) -> None:
        self.pre_get()
        result = super().get(*args, **kwargs)
        if result is not None:
            await result

    def open(self, *args: Any, **kwargs: Any) -> None:
        self._write({"type": "connection", "client_id": uuid.uuid4().hex})

    def on_message(self, raw: str | bytes) -> None:
        try:
            request = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            self.log.warning("Ignoring malformed inline-completion frame")
            return
        if not isinstance(request, dict):
            return
        number = request.get("number")
        if type(number) is not int:
            self.log.warning(
                "Ignoring inline-completion frame without an integer request number"
            )
            return
        task = asyncio.create_task(self._handle_request(number, request))
        self._completion_tasks.add(task)
        task.add_done_callback(self._completion_tasks.discard)

    def on_close(self) -> None:
        for task in tuple(self._completion_tasks):
            task.cancel()
        self._completion_tasks.clear()

    async def _handle_request(self, number: int, request: dict) -> None:
        prefix = request.get("prefix", "")
        suffix = request.get("suffix", "")
        if not isinstance(prefix, str) or not isinstance(suffix, str):
            self._reply_error(
                number, "InvalidCompletionRequest", "Invalid editor context."
            )
            return
        prefix = prefix[-MAX_PREFIX_CHARS:]
        suffix = suffix[:MAX_SUFFIX_CHARS]
        language = request.get("language") or request.get("mime") or "code"
        if not isinstance(language, str):
            language = "code"

        manager = self.settings.get("jupyternaut.config_manager")
        if manager is None:
            self._reply_error(
                number,
                "JupyternautUnavailable",
                "Jupyternaut's model configuration is unavailable.",
            )
            return

        try:
            model_id, model_args = resolve_completion_model(manager)
            if not model_id:
                self._reply_error(
                    number,
                    "NoCompletionModel",
                    "Configure a Jupyternaut model before using inline code completion.",
                )
                return
            validator = getattr(manager, "_validate_model", None)
            if callable(validator) and not validator(model_id, raise_exc=False):
                self._reply_error(
                    number,
                    "ModelNotAllowed",
                    "The configured Jupyternaut model is not allowed for completion.",
                )
                return

            model_args = dict(model_args)
            model_args.pop("model", None)
            model_args.pop("streaming", None)
            model_args.setdefault("temperature", 0.1)
            if model_args.get("max_tokens") is None:
                model_args["max_tokens"] = _MAX_COMPLETION_TOKENS
            stream = bool(request.get("stream", False))
            model = ChatLiteLLM(model=model_id, streaming=stream, **model_args)
            messages = [
                SystemMessage(content=SYSTEM_PROMPT),
                HumanMessage(
                    content=build_inline_prompt(
                        language,
                        prefix,
                        suffix,
                        variables=request.get("variables", []),
                        files=request.get("files", []),
                    )
                ),
            ]

            if stream:
                await self._stream_completion(number, model, messages, prefix, suffix)
            else:
                response = await asyncio.wait_for(
                    model.ainvoke(messages), timeout=_REQUEST_TIMEOUT_SECONDS
                )
                text = clean_completion(
                    extract_message_text(response), prefix=prefix, suffix=suffix
                )
                self._write(
                    {
                        "type": "inline_completion",
                        "reply_to": number,
                        "list": {
                            "items": [{"insertText": text, "isIncomplete": False}]
                            if text
                            else []
                        },
                    }
                )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Keep credentials and prompt contents out of client-visible errors.
            self.log.warning(
                "Inline completion failed for request %s (%s)",
                number,
                type(error).__name__,
            )
            self._reply_error(
                number,
                "InlineCompletionFailed",
                (
                    "Jupyter AI could not generate an inline completion. "
                    "Check the configured model and server logs."
                ),
            )

    async def _stream_completion(
        self,
        number: int,
        model: Any,
        messages: list,
        prefix: str,
        suffix: str,
    ) -> None:
        token = uuid.uuid4().hex
        self._write(
            {
                "type": "inline_completion",
                "reply_to": number,
                "list": {
                    "items": [
                        {"insertText": "", "token": token, "isIncomplete": True}
                    ]
                },
            }
        )
        full_text = ""
        try:
            async with asyncio.timeout(_REQUEST_TIMEOUT_SECONDS):
                async for chunk in model.astream(messages):
                    full_text += extract_message_text(chunk)
                    self._write(
                        {
                            "type": "stream",
                            "reply_to": number,
                            "response": {
                                "insertText": clean_completion(
                                    full_text, prefix=prefix, suffix=suffix
                                ),
                                "token": token,
                                "isIncomplete": True,
                            },
                            "done": False,
                        }
                    )
            self._write(
                {
                    "type": "stream",
                    "reply_to": number,
                    "response": {
                        "insertText": clean_completion(
                            full_text, prefix=prefix, suffix=suffix
                        ),
                        "token": token,
                        "isIncomplete": False,
                    },
                    "done": True,
                }
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.log.warning(
                "Inline completion stream failed (%s)", type(error).__name__
            )
            self._write(
                {
                    "type": "stream",
                    "reply_to": number,
                    "response": {
                        "insertText": clean_completion(
                            full_text, prefix=prefix, suffix=suffix
                        ),
                        "token": token,
                        "isIncomplete": False,
                        "error": {"message": "Inline completion failed."},
                    },
                    "done": True,
                }
            )

    def _reply_error(self, number: int, error_type: str, title: str) -> None:
        self._write(
            {
                "type": "inline_completion",
                "reply_to": number,
                "list": {"items": []},
                "error": {"type": error_type, "title": title, "traceback": ""},
            }
        )

    def _write(self, message: dict) -> None:
        if self.ws_connection is None:
            return
        try:
            self.write_message(json.dumps(message))
        except websocket.WebSocketClosedError:
            pass
