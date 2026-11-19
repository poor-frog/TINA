import unittest

from custom_words_ab import edit_errors, normalize, score, target_alignment


class CustomWordsScoringTests(unittest.TestCase):
    def test_normalization_matches_asr_scoring_conventions(self):
        self.assertEqual(normalize('  TIẾNG, Việt! Don’t '), "tiếng việt don't")
        self.assertEqual(score('Việt', 'Vie\u0323\u0302t')['word_errors'], 0)

    def test_edit_distance_and_target_alignment(self):
        self.assertEqual(edit_errors(['a', 'b'], ['a', 'x', 'b']), 1)
        self.assertEqual(edit_errors([], ['a']), 1)
        self.assertEqual(target_alignment('API server', 'webhook server', ['api', 'webhook']),
                         {'api': {'reference': 1, 'matched': 0, 'missed': 1, 'false_insertions': 0},
                          'webhook': {'reference': 0, 'matched': 0, 'missed': 0, 'false_insertions': 1}})


if __name__ == '__main__':
    unittest.main()
