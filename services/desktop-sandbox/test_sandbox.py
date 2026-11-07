"""Unit tests for the parts of the sandbox that need no display: python3 -m unittest services/desktop-sandbox/test_sandbox.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault('SANDBOX_WORK', '/tmp')
import proxy  # noqa: E402
import sandbox  # noqa: E402


class ProxyTest(unittest.TestCase):
    def test_allow_list(self):
        p = proxy.parse('example.com, *.example.org')
        self.assertTrue(proxy.allowed('example.com', p))
        self.assertFalse(proxy.allowed('sub.example.com', p))
        self.assertTrue(proxy.allowed('a.example.org', p))
        self.assertTrue(proxy.allowed('EXAMPLE.org.', p))
        self.assertFalse(proxy.allowed('evilexample.org', p))
        self.assertFalse(proxy.allowed('example.com.evil.com', p))
        self.assertFalse(proxy.allowed('x', []))


class ActionTest(unittest.TestCase):
    def test_bounds_and_keys(self):
        self.assertEqual(sandbox.check_xy(0, 0), ('0', '0'))
        for bad in [(-1, 0), (sandbox.WIDTH, 0), (0, sandbox.HEIGHT), ('1', 2), (True, 1)]:
            with self.assertRaises(sandbox.Refused):
                sandbox.check_xy(*bad)
        for key in ['Return', 'ctrl+s', 'alt+F4']:
            self.assertTrue(sandbox.KEY_RE.match(key))
        for key in ['ctrl+s; rm -rf /', '', 'a b', '$(id)']:
            self.assertFalse(sandbox.KEY_RE.match(key))

    def test_files_stay_in_work(self):
        self.assertTrue(sandbox.safe_path('a/b.txt').startswith(sandbox.WORK))
        with self.assertRaises(sandbox.Refused):
            sandbox.safe_path('../etc/passwd')
        with self.assertRaises(sandbox.Refused):
            sandbox.safe_path('/etc/passwd')

    def test_unknown_action_and_launch(self):
        with self.assertRaises(sandbox.Refused):
            sandbox.do_action({'action': 'shell', 'text': 'id'})
        with self.assertRaises(sandbox.Refused):
            sandbox.do_action({'action': 'launch', 'app': 'terminal'})


if __name__ == '__main__':
    unittest.main()
