"""Exercise release rejection gates with synthetic data in isolated directories."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

BUILDER = Path(__file__).resolve().parents[1] / 'scripts' / 'build-release.py'

class PrivacyGates(unittest.TestCase):
    def reject(self, name, data, expected, optimized=False):
        with tempfile.TemporaryDirectory(prefix='whale-release-gate-') as folder:
            root = Path(folder)
            (root / 'scripts').mkdir()
            shutil.copyfile(BUILDER, root / 'scripts' / 'build-release.py')
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            args = [sys.executable, '-B'] + (['-O'] if optimized else [])
            env = dict(os.environ)
            env.pop('PYTHONOPTIMIZE', None)
            result = subprocess.run(args + [str(root / 'scripts' / 'build-release.py')], capture_output=True, text=True, env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(expected, result.stderr)
            self.assertFalse((root / 'dist').exists(), 'a rejected build must not emit an archive')

    def test_nested_archive(self):
        self.reject('docs/hidden.zip', b'PK', 'Private or binary file')

    def test_database_sidecar(self):
        self.reject('assets/cache.sqlite-wal', b'database', 'Unexpected file type')

    def test_other_user_path(self):
        value = 'C:/' + 'Users/' + 'synthetic-person/private.txt'
        self.reject('docs/private.md', value.encode(), 'Privacy review required')

    def test_unix_user_path(self):
        value = '/' + 'home/' + 'synthetic-person/private.txt'
        self.reject('docs/private.md', value.encode(), 'Privacy review required')

    def test_fine_grained_token_in_typescript(self):
        token = 'github_' + 'pat_' + 'x' * 40
        self.reject('tests/types.ts', token.encode(), 'Privacy review required')

    def test_json_web_token(self):
        token = 'ey' + 'J' + 'a' * 20 + '.' + 'b' * 20 + '.' + 'c' * 20
        self.reject('docs/settings.toml', token.encode(), 'Privacy review required')

    def test_unknown_gif_application_metadata(self):
        gif = b'GIF89a\x01\x00\x01\x00\x00\x00\x00' + b'!\xff\x0bFAKEAPP1234\x00;'
        self.reject('assets/private.gif', gif, 'unknown GIF application metadata')

    def test_audio_tail_metadata(self):
        self.reject('assets/private.mp3', b'frames' + b'APETAGEX', 'audio trailing metadata')

    def test_optimization_cannot_bypass_privacy(self):
        self.reject('docs/hidden.zip', b'PK', 'without optimization', optimized=True)

if __name__ == '__main__':
    unittest.main()
