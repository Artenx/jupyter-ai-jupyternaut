"""Small, side-effect-free helpers for inline code completion."""

import json
from typing import Any, Dict, Optional, Tuple

MAX_PREFIX_CHARS = 10_000
MAX_SUFFIX_CHARS = 4_000
MAX_RUNTIME_CONTEXT_CHARS = 6_000

SYSTEM_PROMPT = """You are Jupyter AI's inline code-completion engine.
Return only the minimal text to insert at the cursor. Do not repeat text from
before or after the cursor. Do not include Markdown fences, prose, or an
explanation. Respect the existing suffix and indentation. If no useful
completion is possible, return an empty string."""


def resolve_completion_model(
    config_manager: Any,
) -> Tuple[Optional[str], Dict[str, Any]]:
    """Resolve the dedicated completion model, then Jupyternaut's chat model.

    Custom-model IDs are resolved to their LiteLLM IDs and parameters on the
    server; no credentials or model configuration are sent to the browser.
    If only custom models are configured, use the first one as a usable default.
    """
    completion_model = config_manager.completion_model
    if completion_model:
        custom = config_manager.get_custom_model(completion_model)
        if custom is not None:
            return custom.model_id, dict(custom.params)
        if completion_model.startswith("custom-"):
            return None, {}
        return completion_model, dict(config_manager.completion_model_params or {})

    chat_model = config_manager.chat_model
    if chat_model:
        custom = config_manager.get_custom_model(chat_model)
        if custom is not None:
            return custom.model_id, dict(custom.params)
        if chat_model.startswith("custom-"):
            return None, {}
        return chat_model, dict(config_manager.chat_model_args or {})

    custom_models = config_manager.custom_models
    if custom_models:
        custom = custom_models[0]
        return custom.model_id, dict(custom.params)

    return None, {}


def _sanitize_runtime_context(variables: Any, files: Any) -> Dict[str, Any]:
    """Keep only small schema metadata; never forward arbitrary kernel values."""
    safe_files = []
    if isinstance(files, list):
        safe_files = [value[:80] for value in files[:20] if isinstance(value, str)]

    safe_variables = []
    if isinstance(variables, list):
        for item in variables[:40]:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                continue
            variable = {
                "name": item["name"][:80],
                "type": str(item.get("type", "unknown"))[:80],
            }
            shape = item.get("shape")
            if isinstance(shape, list) and len(shape) <= 3:
                variable["shape"] = [
                    int(value) for value in shape if isinstance(value, (int, float))
                ]
            columns = item.get("columns")
            if isinstance(columns, list):
                variable["columns"] = [str(value)[:80] for value in columns[:15]]
            dtypes = item.get("dtypes")
            if isinstance(dtypes, dict):
                variable["dtypes"] = {
                    str(key)[:80]: str(value)[:40]
                    for key, value in list(dtypes.items())[:15]
                }
            candidate = safe_variables + [variable]
            candidate_text = json.dumps(
                {"variables": candidate, "files": safe_files}, ensure_ascii=False
            )
            if len(candidate_text) > MAX_RUNTIME_CONTEXT_CHARS:
                break
            safe_variables.append(variable)
    return {"variables": safe_variables, "files": safe_files}


def build_inline_prompt(
    language: str,
    prefix: str,
    suffix: str,
    variables: Any = None,
    files: Any = None,
) -> str:
    """Build a compact FIM prompt with cached, schema-only notebook context."""
    prefix = prefix[-MAX_PREFIX_CHARS:]
    suffix = suffix[:MAX_SUFFIX_CHARS]
    context = _sanitize_runtime_context(variables, files)
    metadata = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    return (
        f"Language: {language or 'code'}\n"
        "Notebook runtime metadata (names, types, DataFrame shape/schema and "
        "nearby data-file names only; it contains no row samples or variable values):\n"
        f"{metadata}\n"
        "Complete the source at the cursor. The prefix and suffix are existing "
        "editor text; return only the insertion between them.\n"
        "<PREFIX>\n"
        f"{prefix}"
        "<CURSOR>"
        f"{suffix}"
        "\n</SUFFIX>"
    )


def extract_message_text(message: Any) -> str:
    """Extract text from LangChain messages and streaming chunks."""
    content = getattr(message, "content", message)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return ""


def clean_completion(text: str, prefix: str = "", suffix: str = "") -> str:
    """Remove common code-fence/context echoes while preserving indentation."""
    text = (text or "").replace("\r\n", "\n").strip("\r\n")
    if text.strip() in {"<NO_COMPLETION>", "NO_COMPLETION"}:
        return ""
    if text.startswith("```"):
        first_newline = text.find("\n")
        text = text[first_newline + 1 :] if first_newline >= 0 else ""
        last_fence = text.rfind("```")
        if last_fence >= 0:
            text = text[:last_fence]
        text = text.strip("\r\n")

    prefix_line = prefix.splitlines()[-1] if prefix.splitlines() else ""
    suffix_line = suffix.splitlines()[0] if suffix.splitlines() else ""
    if prefix_line and text.startswith(prefix_line):
        text = text[len(prefix_line) :]
    if suffix_line and text.endswith(suffix_line):
        text = text[: -len(suffix_line)]
    return text
