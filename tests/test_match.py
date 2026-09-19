from __future__ import annotations

import unittest

from src.boards import is_relevant_listing
from src.jobs import Job
from src.match import NOT_SUITED_PREFIX, score_job
from src.profile import load_profile


def _job(title: str, description: str = "", location: str = "Bengaluru, India", remote: bool | None = True) -> Job:
    return Job(
        id="t-1",
        source="test",
        title=title,
        company="Example",
        url="https://example.com/job",
        location=location,
        description=description,
        tags=[],
        posted_at="2026-09-18",
        remote=remote,
    )


class MatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.profile = load_profile()

    def test_cloud_engineer_aws_gcp_is_suited(self) -> None:
        job = _job(
            "Cloud Engineer",
            "Own GKE and AWS EKS. Terraform, Kubernetes, ArgoCD, Prometheus, IAM.",
        )
        scored = score_job(job, self.profile)
        self.assertIsNotNone(scored)
        assert scored is not None
        self.assertEqual(scored.fit, "suited")
        self.assertTrue({"AWS", "GCP"} & set(scored.matched_clouds))

    def test_software_engineer_kept_when_skills_match(self) -> None:
        job = _job(
            "Software Engineer",
            "Build platform tooling on GCP with Kubernetes, Terraform, and Python CI/CD.",
        )
        scored = score_job(job, self.profile)
        self.assertIsNotNone(scored)
        assert scored is not None
        self.assertIn(scored.fit, {"suited", "stretch"})
        self.assertIn("Kubernetes", scored.matched_skills)

    def test_frontend_software_engineer_dropped(self) -> None:
        job = _job("Frontend Software Engineer", "React, CSS, accessibility. No cloud.")
        self.assertIsNone(score_job(job, self.profile))

    def test_azure_only_is_stretch_or_gap(self) -> None:
        job = _job(
            "SRE",
            "Azure AKS, Entra ID, ARM templates, Kubernetes, Terraform, Prometheus. 4 years.",
        )
        scored = score_job(job, self.profile)
        self.assertIsNotNone(scored)
        assert scored is not None
        self.assertIn("Azure", scored.matched_clouds)
        self.assertIn(scored.cloud_fit, {"transferable", "confident"})
        if scored.fit == "not_suited":
            self.assertTrue(scored.fit_summary.startswith(NOT_SUITED_PREFIX))

    def test_not_suited_has_gap_plan_phrase(self) -> None:
        job = _job(
            "Staff SRE",
            "8+ years. Java and OpenShift on Oracle Cloud OCI. Istio, Pulumi, Crossplane required.",
        )
        scored = score_job(job, self.profile)
        self.assertIsNotNone(scored)
        assert scored is not None
        self.assertEqual(scored.fit, "not_suited")
        self.assertTrue(scored.fit_summary.startswith(NOT_SUITED_PREFIX))
        self.assertTrue(scored.gap_plan)

    def test_generic_software_engineer_not_crawled_without_skills(self) -> None:
        self.assertFalse(is_relevant_listing("Software Engineer"))
        self.assertTrue(is_relevant_listing("Software Engineer, Platform"))
        self.assertTrue(is_relevant_listing("Cloud Engineer"))
        self.assertTrue(
            is_relevant_listing(
                "Member of Technical Staff",
                "Kubernetes Terraform AWS production platform",
            )
        )

    def test_global_regions_score_like_india(self) -> None:
        india = score_job(
            _job("SRE", "Kubernetes Terraform AWS Prometheus.", location="Bengaluru, India", remote=False),
            self.profile,
        )
        london = score_job(
            _job("SRE", "Kubernetes Terraform AWS Prometheus.", location="London, UK", remote=False),
            self.profile,
        )
        singapore = score_job(
            _job("Cloud Engineer", "GKE Terraform GitOps.", location="Singapore", remote=False),
            self.profile,
        )
        nyc = score_job(
            _job("Platform Engineer", "EKS Kubernetes Terraform.", location="New York, United States", remote=False),
            self.profile,
        )
        self.assertIsNotNone(india)
        self.assertIsNotNone(london)
        self.assertIsNotNone(singapore)
        self.assertIsNotNone(nyc)
        assert india and london and singapore and nyc
        self.assertIn("India", india.regions)
        self.assertIn("UK", london.regions)
        self.assertIn("EMEA", london.regions)
        self.assertIn("Singapore", singapore.regions)
        self.assertIn("APAC", singapore.regions)
        self.assertIn("US", nyc.regions)
        self.assertGreaterEqual(india.location_score, singapore.location_score)
        self.assertGreaterEqual(singapore.location_score, london.location_score)
        self.assertLess(nyc.location_score, london.location_score)
        germany = score_job(
            _job("SRE", "Kubernetes Terraform AWS Prometheus.", location="Berlin, Germany", remote=False),
            self.profile,
        )
        dubai = score_job(
            _job("Platform Engineer", "EKS Kubernetes Terraform.", location="Dubai, UAE", remote=False),
            self.profile,
        )
        stockholm = score_job(
            _job("SRE", "Kubernetes Terraform AWS Prometheus.", location="Stockholm, Sweden", remote=False),
            self.profile,
        )
        self.assertIsNotNone(germany)
        self.assertIsNotNone(dubai)
        self.assertIsNotNone(stockholm)
        assert germany and dubai and stockholm
        self.assertIn("Germany", germany.regions)
        self.assertIn("Middle East", dubai.regions)
        self.assertIn("Nordics", stockholm.regions)
        self.assertIn("EMEA", stockholm.regions)
        self.assertGreater(london.location_score, germany.location_score)
        self.assertGreater(germany.location_score, nyc.location_score)
        self.assertGreaterEqual(dubai.location_score, germany.location_score)
        self.assertGreater(india.location_score, stockholm.location_score)


if __name__ == "__main__":
    unittest.main()
