"""Tests for sync.py: python3 -m unittest discover -s services/dash/client-sync"""
import unittest

import sync

VERSION_ONLY = """{
<<<<<<< HEAD
  "productName": "Forever Dash Client",
  "version": "1.0.1",
||||||| base
  "productName": "Polestar Client",
  "version": "0.1.4",
=======
  "productName": "Polestar Client",
  "version": "0.1.6",
>>>>>>> refs/upstream/client-v0.1.6
}
"""

REAL_CHANGE = """[[package]]
<<<<<<< HEAD
version = "1.0.1"
dependencies = ["a"]
||||||| base
version = "0.1.4"
dependencies = ["a"]
=======
version = "0.1.6"
dependencies = ["a", "b"]
>>>>>>> refs/upstream/client-v0.1.6
"""


class Resolve(unittest.TestCase):
    def test_version_only_keeps_ours(self):
        text, left = sync.resolve_text(VERSION_ONLY)
        self.assertEqual(left, 0)
        self.assertEqual(text, '{\n  "productName": "Forever Dash Client",\n  "version": "1.0.1",\n}\n')

    def test_other_change_stays(self):
        text, left = sync.resolve_text(REAL_CHANGE)
        self.assertEqual(left, 1)
        self.assertEqual(text, REAL_CHANGE)


class Next(unittest.TestCase):
    def test_above_tags_and_current(self):
        self.assertEqual(sync.next_version("1.0.1", ["client-v1.0.0", "client-v1.0.3", "client-v0.1.6"]), "1.0.4")
        self.assertEqual(sync.next_version("1.0.1", []), "1.0.2")
        self.assertEqual(sync.next_version("1.0.10", ["client-v1.0.9", "client-vx"]), "1.0.11")


class Notes(unittest.TestCase):
    def test_takes_whats_new(self):
        body = "Intro\n\n## What's new\n\n- One.\n- Two.\n\n## Download\n\ntable\n"
        out = sync.notes("1.0.2", "0.1.6", body)
        self.assertIn("Forever Dash Client 1.0.2", out)
        self.assertIn("releases/tag/client-v0.1.6", out)
        self.assertIn("- One.\n- Two.\n", out)
        self.assertNotIn("table", out)


if __name__ == "__main__":
    unittest.main()
