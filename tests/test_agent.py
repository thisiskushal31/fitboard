"""Agent briefing: heuristic path always, LLM path only when use_llm is True."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from src.agent import run_agent
from src.jobs import Job
from src.profile import load_profile


def _job() -> Job:
    return Job(
        id="1",
        source="test",
        title="DevOps Engineer",
        company="Acme",
        url="https://example.com/devops",
        location="Bengaluru, India",
        description="Kubernetes Terraform GitOps AWS GCP Prometheus.",
    )


class AgentLlmGateTests(unittest.TestCase):
    def test_llm_is_not_called_when_toggle_is_off(self) -> None:
        profile = load_profile()
        with patch("src.agent.collect_jobs", return_value=([_job()], [])):
            with patch("src.agent._llm_brief") as llm:
                report = run_agent(profile, use_llm=False)
        llm.assert_not_called()
        self.assertFalse(report["used_llm"])
        self.assertIsNone(report["llm_provider"])
        self.assertIn("Agent briefing", report["brief"])

    def test_llm_is_called_only_when_toggle_is_on_and_key_exists(self) -> None:
        profile = load_profile()
        with patch("src.agent.collect_jobs", return_value=([_job()], [])):
            with patch("src.agent.has_llm_key", return_value=True):
                with patch("src.agent._llm_brief", return_value="LLM TEXT") as llm:
                    report = run_agent(profile, use_llm=True)
        llm.assert_called_once()
        self.assertTrue(report["used_llm"])
        self.assertIn("LLM TEXT", report["brief"])

    def test_reuses_existing_crawl_instead_of_fetching_again(self) -> None:
        profile = load_profile()
        jobs = [_job()]
        with patch("src.agent.collect_jobs") as collect:
            report = run_agent(profile, use_llm=False, jobs=jobs, errors=[])
        collect.assert_not_called()
        self.assertEqual(report["jobs"], jobs)


if __name__ == "__main__":
    unittest.main()
