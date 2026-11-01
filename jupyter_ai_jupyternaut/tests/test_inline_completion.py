"""Tests for the Jupyternaut inline completion model and prompt helpers."""

from types import SimpleNamespace

from jupyter_ai_jupyternaut.completions.utils import (
    build_inline_prompt,
    clean_completion,
    extract_message_text,
    resolve_completion_model,
)


class FakeConfigManager:
    def __init__(self, completion=None, chat=None, custom_models=None):
        self.completion_model = completion
        self.chat_model = chat
        self.custom_models = custom_models or []
        self.completion_model_params = {"temperature": 0.0}
        self.chat_model_args = {"temperature": 0.2}

    def get_custom_model(self, model_id):
        return next(
            (model for model in self.custom_models if model.id == model_id), None
        )


def test_dedicated_completion_model_takes_precedence_and_resolves_custom_model():
    custom = SimpleNamespace(
        id="custom-inline",
        model_id="openai/gpt-4o-mini",
        params={"temperature": 0.0},
    )
    manager = FakeConfigManager(
        completion="custom-inline", chat="openai/chat", custom_models=[custom]
    )

    assert resolve_completion_model(manager) == (
        "openai/gpt-4o-mini",
        {"temperature": 0.0},
    )


def test_completion_model_falls_back_to_chat_then_first_custom():
    manager = FakeConfigManager(chat="openai/chat")
    assert resolve_completion_model(manager) == ("openai/chat", {"temperature": 0.2})

    custom = SimpleNamespace(id="custom-first", model_id="openai/first", params={})
    manager = FakeConfigManager(custom_models=[custom])
    assert resolve_completion_model(manager) == ("openai/first", {})


def test_prompt_contains_language_and_both_sides_of_cursor():
    prompt = build_inline_prompt("python", "x = ", "\nprint(x)")
    assert "Language: python" in prompt
    assert "x = <CURSOR>\nprint(x)" in prompt
    assert "return only the insertion" in prompt


def test_prompt_includes_sanitized_runtime_metadata_only():
    prompt = build_inline_prompt(
        "python",
        "df_sales.groupby(",
        "",
        variables=[
            {
                "name": "df_sales",
                "type": "DataFrame",
                "shape": [25, 3],
                "columns": ["order_id", "customer_id", "amount"],
                "dtypes": {"amount": "float64"},
                "sample_values": ["private-value"],
            }
        ],
        files=["sales.csv"],
    )
    assert "df_sales" in prompt
    assert "customer_id" in prompt
    assert "amount" in prompt
    assert "sales.csv" in prompt
    assert "private-value" not in prompt


def test_clean_completion_removes_fences_and_duplicate_context():
    assert clean_completion("```python\nvalue = 1\n```") == "value = 1"
    assert clean_completion(
        "prefix\nnew line\nsuffix", "prefix", "suffix"
    ) == "\nnew line\n"


def test_extract_text_supports_langchain_content_blocks():
    message = SimpleNamespace(content=[{"type": "text", "text": "x = "}, "1"])
    assert extract_message_text(message) == "x = 1"
