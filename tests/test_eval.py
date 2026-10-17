import json
import pathlib
import unittest
import eval_jev as ev

ROOT = pathlib.Path(__file__).parent

class EvalTests(unittest.TestCase):
    def test_shared_metrics(self):
        fixture = json.loads((ROOT / 'fixtures/metrics.json').read_text(encoding='utf-8'))
        self.assertEqual(ev.binary_metrics(fixture['records'], fixture['threshold']), fixture['binary'])
        self.assertEqual(ev.category_metrics(fixture['records']), fixture['category'])

    def test_zero_f1_and_empty(self):
        row = dict(label='scam', choice='正常訊息', p_scam=0.1, error=None)
        self.assertEqual(ev.binary_metrics([row], .7)['f1'], 0)
        self.assertIsNone(ev.binary_metrics([], .7)['f1'])

    def test_shared_api_fixture(self):
        fixture = json.loads((ROOT / 'fixtures/jev.json').read_text(encoding='utf-8'))
        choice, probs, signals = ev.parse_answers(fixture)
        self.assertEqual(choice, '假投資')
        self.assertAlmostEqual(ev.p_scam_of(choice, probs), .99)
        self.assertEqual(set(signals), set(ev.SIGNALS))
        del fixture['answers']['category']['probabilities']
        with self.assertRaises(ValueError): ev.parse_answers(fixture)

    def test_no_hard_fallback(self):
        with self.assertRaises(ValueError): ev.p_scam_of(None, None)
        with self.assertRaises(ValueError): ev.parse_answers({})

    def test_question_definitions_match(self):
        questions = json.loads((ROOT / 'fixtures/questions.json').read_text(encoding='utf-8'))
        self.assertEqual(ev.build_questions(), questions)

    def test_promptfoo_suite_uses_same_questions(self):
        config = json.loads((ROOT.parent / 'promptfooconfig.yaml').read_text(encoding='utf-8'))
        self.assertEqual(config['providers'][0]['config']['questions'], ev.build_questions())
        self.assertEqual(len(config['tests']), 25)

if __name__ == '__main__': unittest.main()
