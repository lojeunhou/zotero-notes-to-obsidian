from __future__ import annotations

import unittest

from zotero_notes_to_obsidian.cli import html_to_markdown, safe_filename


class MarkdownConversionTests(unittest.TestCase):
    def test_converts_headings_lists_and_emphasis(self) -> None:
        html = (
            "<div><h2>Notes</h2><ul><li><p>First</p></li>"
            "<li><strong>Second</strong></li></ul></div>"
        )

        markdown = html_to_markdown(html)

        self.assertIn("## Notes", markdown)
        self.assertIn("- First", markdown)
        self.assertIn("- **Second**", markdown)

    def test_converts_links(self) -> None:
        markdown = html_to_markdown('<p>Read <a href="https://example.com">this</a>.</p>')

        self.assertIn("[this](https://example.com)", markdown)


class FilenameTests(unittest.TestCase):
    def test_safe_filename_keeps_key_and_removes_bad_characters(self) -> None:
        filename = safe_filename('A/B:C*"D"?', "ABCD1234")

        self.assertEqual(filename, "A - B - C - D [ABCD1234].md")


if __name__ == "__main__":
    unittest.main()
