from __future__ import annotations

import unittest

from src.career import (
    CareerConfig,
    _layers_for,
    build_career_report,
    render_career_markdown,
)
from src.jobs import Job
from src.profile import load_profile


def _job(title: str, description: str) -> Job:
    return Job(
        id=title,
        source="test",
        title=title,
        company="Example",
        url="https://example.com/" + title.replace(" ", "-"),
        location="Bengaluru, India",
        description=description,
    )


class CareerPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.profile = load_profile()
        self.config = CareerConfig(
            current_roles=["DevOps Engineer", "Software Engineer"],
            next_roles=["Platform Engineer", "MLOps Engineer", "AI Engineer"],
            destination_roles=["Threat Intelligence", "Security Engineering"],
            trending=["Forward-Deployed Engineer"],
            learning_now=["RAG evaluation", "MITRE ATT&CK"],
            search_queries=[],
        )

    def test_fde_stays_in_line_as_software_plus_platform(self) -> None:
        self.assertEqual(_layers_for("Forward-Deployed Engineer"), ["software", "platform"])

    def test_report_names_lacking_skills_from_boards(self) -> None:
        jobs = [
            _job("DevOps Engineer", "Kubernetes Terraform GitOps AWS GCP Prometheus IAM Python."),
            _job("MLOps Engineer", "Vertex AI, MLflow, GPU, model registry, Kubeflow."),
            _job(
                "Forward Deployed Engineer",
                "Python Go Kubernetes customer integration embeddings LLM API.",
            ),
            _job("Detection Engineer", "MITRE ATT&CK SIEM Sigma YARA GuardDuty threat intel."),
        ]
        report = build_career_report(jobs, self.profile, self.config)
        self.assertEqual([role.name for role in report.current], ["DevOps Engineer", "Software Engineer"])
        self.assertEqual([role.name for role in report.destination], ["Threat Intelligence", "Security Engineering"])
        self.assertEqual(report.trending[0].name, "Forward-Deployed Engineer")
        self.assertTrue(report.trending[0].listing_count)
        lacking_names = {g.skill for g in report.checks}
        self.assertTrue({"mlflow", "kubeflow", "sigma", "siem"} & lacking_names)
        text = render_career_markdown(report)
        self.assertIn("Companies fire without notice", text)
        self.assertIn("You're lacking", text)
        self.assertIn("Forward-Deployed Engineer", text)
        self.assertIn("sit with a real user problem", text.lower())

    def test_yaml_trending_can_be_unknown_title(self) -> None:
        cfg = CareerConfig(
            current_roles=["DevOps Engineer"],
            next_roles=["Platform Engineer"],
            destination_roles=["Security Engineering"],
            trending=["Staff Context Engineer"],
            learning_now=[],
            search_queries=[],
        )
        report = build_career_report([], self.profile, cfg)
        self.assertEqual(report.trending[0].name, "Staff Context Engineer")
        self.assertIn("Keep this in line", report.trending[0].next_move)

    def test_yaml_loads_multiple_roles(self) -> None:
        from src.career import extra_search_queries, load_career_config

        cfg = load_career_config()
        self.assertGreaterEqual(len(cfg.current_roles), 2)
        self.assertGreaterEqual(len(cfg.next_roles), 2)
        self.assertGreaterEqual(len(cfg.destination_roles), 2)
        queries = extra_search_queries(cfg)
        self.assertTrue(any("devops" in q for q in queries))
        self.assertTrue(any("mlops" in q for q in queries))
        self.assertTrue(any("threat" in q for q in queries))


if __name__ == "__main__":
    unittest.main()
