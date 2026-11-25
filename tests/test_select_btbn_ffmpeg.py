import unittest

from scripts.select_btbn_ffmpeg import select_release


class SelectBtbnFfmpegTests(unittest.TestCase):
    legacy = "ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz"
    versioned = "ffmpeg-n8.1.3-41-ga8029b6528-linux64-gpl-8.1.tar.xz"

    def test_selects_versioned_static_asset(self):
        self.assertEqual(self.select(self.versioned, self.versioned.replace("-gpl-", "-gpl-shared-"),
                                     self.versioned.replace("8.1", "9.0")), ("autobuild-test", self.versioned))

    def test_keeps_support_for_legacy_filename(self):
        self.assertEqual(self.select(self.legacy), ("autobuild-test", self.legacy))

    def test_rejects_missing_or_ambiguous_exact_matches(self):
        for names in [(), (self.versioned, self.versioned.replace("-41-", "-42-"))]:
            with self.subTest(names=names), self.assertRaises(ValueError):
                self.select(*names)

    def test_requires_checksum_manifest(self):
        with self.assertRaises(ValueError):
            select_release({"tag_name": "autobuild-test", "assets": [{"name": self.versioned}]}, "8.1")

    def select(self, *names):
        return select_release({
            "tag_name": "autobuild-test",
            "assets": [{"name": name} for name in (*names, "checksums.sha256")],
        }, "8.1")
