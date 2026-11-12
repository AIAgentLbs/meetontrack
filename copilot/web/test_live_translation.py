import unittest
from unittest.mock import patch

from live_translation import LiveTranslation


class LiveTranslationTests(unittest.TestCase):
    def setUp(self):
        self.translator = LiveTranslation()

    def tearDown(self):
        self.translator.pool.shutdown(wait=True)

    def test_portuguese_gets_english_without_overwriting_original(self):
        key = ("meeting-1", "system", "2026-09-25T17:41:00Z")
        original = "Eles têm uma ferramenta para encontrar clientes no Brasil."
        with patch.object(LiveTranslation, "_language", return_value=("pt", 0.99)), \
             patch.object(LiveTranslation, "_translate", return_value="They have a tool to find clients in Brazil."):
            self.translator._work(key, original)
        result = self.translator.annotate({
            "meeting_id": "meeting-1", "segments": [
                {"source": "system", "timestamp": key[2], "text": original,
                 "provisional": False}
            ],
        })
        self.assertEqual(result["segments"][0]["text"], original)
        self.assertEqual(result["segments"][0]["language"], "pt")
        self.assertEqual(result["segments"][0]["translation_en"],
                         "They have a tool to find clients in Brazil.")

    def test_english_and_russian_are_not_sent_for_translation(self):
        for code in ("en", "ru"):
            with self.subTest(code=code), \
                 patch.object(LiveTranslation, "_language", return_value=(code, 0.99)), \
                 patch.object(LiveTranslation, "_translate") as translate:
                self.translator._work(("meeting-1", code, code), "A complete sentence.")
                translate.assert_not_called()

    def test_translation_is_bound_to_meeting_id(self):
        key = ("meeting-1", "system", "2026-09-25T17:41:00Z")
        with patch.object(LiveTranslation, "_language", return_value=("pt", 0.99)), \
             patch.object(LiveTranslation, "_translate", return_value="In English"):
            self.translator._work(key, "Esta é uma frase em português.")
        with patch.object(self.translator.pool, "submit"):
            result = self.translator.annotate({
                "meeting_id": "meeting-2", "segments": [
                    {"source": "system", "timestamp": key[2],
                     "text": "Esta é uma frase em português.", "provisional": False}
                ],
            })
        self.assertNotIn("translation_en", result["segments"][0])

    def test_a_translation_repeating_its_source_is_not_stored(self):
        # MEETONTRACK-64: a short Russian phrase misdetected as Bulgarian comes back unchanged.
        key = ("meeting-1", "system", "t1")
        with patch.object(LiveTranslation, "_language", return_value=("bg", 1.0)), \
             patch.object(LiveTranslation, "_translate", return_value="Да, конечно, давайте."):
            self.translator._work(key, "да конечно давайте")
        self.assertEqual(self.translator.results[key]["translation_en"], "")

    def test_a_needed_choice_is_announced_and_kept_until_the_ai_answers(self):
        from ai_providers import AIChoiceError
        foreign, english = ("meeting-1", "system", "t1"), ("meeting-1", "system", "t2")
        with patch.object(self.translator.pool, "submit"):
            self.translator.annotate({"meeting_id": "meeting-1", "segments": []})
        before = self.translator.revision
        with patch.object(LiveTranslation, "_language", return_value=("pt", 0.99)), \
             patch.object(LiveTranslation, "_translate", side_effect=AIChoiceError("needs_choice", "choose")):
            self.translator._work(foreign, "Esta é uma frase em português.")
        self.assertGreater(self.translator.revision, before)  # MEETONTRACK-51: cached snapshots refresh
        with patch.object(LiveTranslation, "_language", return_value=("en", 0.99)):
            self.translator._work(english, "A complete English sentence.")
        self.assertEqual(self.translator.error_state, "needs_choice")  # MEETONTRACK-52
        with patch.object(LiveTranslation, "_language", return_value=("pt", 0.99)), \
             patch.object(LiveTranslation, "_translate", return_value="In English"):
            self.translator._work(foreign, "Esta é uma frase em português.")
        self.assertEqual(self.translator.error_state, "")


if __name__ == "__main__":
    unittest.main()
