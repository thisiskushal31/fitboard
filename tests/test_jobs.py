from __future__ import annotations

import unittest

from src.jobs import codeforces_jobs_from_payload, jobs_from_arbeitsagentur, jobs_from_mycareersfuture


class CodeforcesHiringTests(unittest.TestCase):
    def test_keeps_hiring_blog_and_skips_noise(self) -> None:
        payload = {
            "status": "OK",
            "result": [
                {
                    "blogEntry": {
                        "id": 111,
                        "title": "Editorial for Round 900",
                        "authorHandle": "tourist",
                        "tags": ["editorial"],
                        "creationTimeSeconds": 1700000000,
                    },
                    "comment": {"text": "nice round"},
                },
                {
                    "blogEntry": {
                        "id": 222,
                        "title": "We are hiring DevOps / SRE",
                        "authorHandle": "spectraltech",
                        "tags": ["hiring"],
                        "creationTimeSeconds": 1700000100,
                    },
                    "comment": {"text": "Remote SRE role, Kubernetes and AWS."},
                },
            ],
        }
        jobs = codeforces_jobs_from_payload(payload)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].id, "codeforces-222")
        self.assertEqual(jobs[0].source, "Codeforces")
        self.assertIn("hiring", jobs[0].title.lower())
        self.assertEqual(jobs[0].url, "https://codeforces.com/blog/entry/222")

    def test_dedupes_same_blog(self) -> None:
        payload = {
            "status": "OK",
            "result": [
                {
                    "blogEntry": {"id": 7, "title": "Hiring platform engineer", "authorHandle": "co"},
                    "comment": {"text": "first"},
                },
                {
                    "blogEntry": {"id": 7, "title": "Hiring platform engineer", "authorHandle": "co"},
                    "comment": {"text": "second"},
                },
            ],
        }
        jobs = codeforces_jobs_from_payload(payload)
        self.assertEqual(len(jobs), 1)


class CountryBoardTests(unittest.TestCase):
    def test_mycareersfuture_keeps_devops(self) -> None:
        payload = {
            "results": [
                {
                    "uuid": "abc",
                    "title": "DevOps Engineer",
                    "description": "Kubernetes, Terraform, AWS pipelines.",
                    "postedCompany": {"name": "UNITED OVERSEAS BANK LIMITED"},
                    "metadata": {
                        "jobDetailsUrl": "https://www.mycareersfuture.gov.sg/job/abc",
                        "newPostingDate": "2026-09-04",
                    },
                    "address": {"districts": [{"location": "Islandwide"}]},
                    "salary": {"minimum": 7000, "maximum": 12000},
                },
                {
                    "uuid": "skip",
                    "title": "Retail Teller",
                    "description": "Cash handling and customer service.",
                    "postedCompany": {"name": "Bank"},
                    "metadata": {"jobDetailsUrl": "https://www.mycareersfuture.gov.sg/job/skip"},
                },
            ]
        }
        jobs = jobs_from_mycareersfuture(payload)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].company, "UNITED OVERSEAS BANK LIMITED")
        self.assertIn("Singapore", jobs[0].location)
        self.assertEqual(jobs[0].source, "MyCareersFuture (SG)")

    def test_arbeitsagentur_builds_jobdetail_url(self) -> None:
        payload = {
            "ergebnisliste": [
                {
                    "stellenangebotsTitel": "DevOps Engineer (m/w/d)",
                    "firma": "FERCHAU GmbH",
                    "referenznummer": "12265-488608_JB5250369-S",
                    "stellenlokationen": [{"adresse": {"ort": "Kassel, Hessen"}}],
                    "datumErsteVeroeffentlichung": "2026-09-18",
                    "gehaltsspanneVon": 50000.0,
                    "gehaltsspanneBis": 70000.0,
                }
            ]
        }
        jobs = jobs_from_arbeitsagentur(payload)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].company, "FERCHAU GmbH")
        self.assertIn("Germany", jobs[0].location)
        self.assertIn("12265-488608_JB5250369-S", jobs[0].url)
        self.assertEqual(jobs[0].source, "Agentur für Arbeit (DE)")


if __name__ == "__main__":
    unittest.main()
