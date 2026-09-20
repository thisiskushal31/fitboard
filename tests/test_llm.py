"""LLM provider selection from environment keys."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from src.llm import (
    active_provider,
    complete,
    cursor_chat_url,
    cursor_needs_chat_gateway,
    default_llm_toggle,
    has_llm_key,
)


class LlmProviderTests(unittest.TestCase):
    def test_no_keys_means_no_provider(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(active_provider())
            self.assertFalse(has_llm_key())
            self.assertFalse(cursor_needs_chat_gateway())

    def test_anthropic_beats_openai(self) -> None:
        env = {"ANTHROPIC_API_KEY": "sk-ant-test", "OPENAI_API_KEY": "sk-test"}
        with patch.dict("os.environ", env, clear=True):
            self.assertEqual(active_provider(), "anthropic")
            self.assertTrue(has_llm_key())

    def test_claude_api_key_alias(self) -> None:
        with patch.dict("os.environ", {"CLAUDE_API_KEY": "sk-ant-test"}, clear=True):
            self.assertEqual(active_provider(), "anthropic")

    def test_openai_with_custom_base_url_still_openai(self) -> None:
        env = {"OPENAI_API_KEY": "sk-test", "OPENAI_BASE_URL": "https://example.com/v1"}
        with patch.dict("os.environ", env, clear=True):
            self.assertEqual(active_provider(), "openai")

    def test_cursor_key_alone_is_not_a_chat_provider(self) -> None:
        with patch.dict("os.environ", {"CURSOR_API_KEY": "crsr_test"}, clear=True):
            self.assertIsNone(active_provider())
            self.assertFalse(has_llm_key())
            self.assertTrue(cursor_needs_chat_gateway())
            self.assertEqual(cursor_chat_url(), "")

    def test_cursor_with_gateway_is_selected(self) -> None:
        env = {
            "CURSOR_API_KEY": "crsr_test",
            "CURSOR_BASE_URL": "https://gateway.example/v1",
        }
        with patch.dict("os.environ", env, clear=True):
            self.assertEqual(active_provider(), "cursor")
            self.assertTrue(has_llm_key())
            self.assertEqual(cursor_chat_url(), "https://gateway.example/v1/chat/completions")
            self.assertFalse(cursor_needs_chat_gateway())

    def test_llm_provider_override(self) -> None:
        env = {
            "ANTHROPIC_API_KEY": "sk-ant-test",
            "OPENAI_API_KEY": "sk-test",
            "LLM_PROVIDER": "openai",
        }
        with patch.dict("os.environ", env, clear=True):
            self.assertEqual(active_provider(), "openai")

    def test_toggle_defaults_off(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertFalse(default_llm_toggle())

    def test_toggle_reads_enable_flag(self) -> None:
        with patch.dict("os.environ", {"FITBOARD_ENABLE_LLM": "true"}, clear=True):
            self.assertTrue(default_llm_toggle())

    def test_complete_does_not_hit_network_when_disabled(self) -> None:
        with patch.dict("os.environ", {"OPENAI_API_KEY": "sk-test"}, clear=True):
            with patch("src.llm.requests.post") as post:
                self.assertIsNone(complete("hello"))
                post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
