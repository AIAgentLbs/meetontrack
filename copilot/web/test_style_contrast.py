"""MEETONTRACK-22: text tokens keep WCAG AA 4.5:1 on every surface, in both themes,
and no rule shrinks text below 11px."""
import re
import unittest
from pathlib import Path

CSS = (Path(__file__).with_name("styles.css")).read_text()
TEXT = ("--text", "--muted", "--faint", "--accent", "--accent-strong", "--danger", "--warning")
SURFACES = ("--page", "--surface", "--surface-strong", "--surface-muted", "--accent-soft")


def tokens(block):
    return dict(re.findall(r"(--[\w-]+):\s*(#[0-9a-fA-F]{6});", block))


def luminance(hex_color):
    channels = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    r, g, b = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


class StyleContrastTests(unittest.TestCase):
    def test_text_tokens_meet_aa_on_every_surface_in_both_themes(self):
        light = tokens(CSS.split("@media (prefers-color-scheme: dark)")[0].split("}")[0])
        dark_block = re.search(r"@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{([^}]*)}", CSS).group(1)
        dark = {**light, **tokens(dark_block)}
        for theme, values in (("light", light), ("dark", dark)):
            for text in TEXT:
                for surface in SURFACES:
                    with self.subTest(theme=theme, text=text, surface=surface):
                        self.assertGreaterEqual(contrast(values[text], values[surface]), 4.5)

    def test_no_text_below_11px(self):
        sizes = [int(size) for size in re.findall(r"font-size:\s*(\d+)px", CSS)]
        self.assertGreaterEqual(min(sizes), 11)


if __name__ == "__main__":
    unittest.main()
