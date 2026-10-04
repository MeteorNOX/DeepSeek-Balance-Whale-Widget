"""Build clean, reproducible public archives without reading user configuration."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import struct
import zipfile
from urllib.parse import unquote

# Never let Python optimization disable the release privacy gates below.
if not __debug__:
    raise RuntimeError('Release privacy validation requires Python without optimization.')

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--release-tag', help='Public release tag; omitted for local candidate builds')
parser.add_argument('--publication-ready', action='store_true', help='Record explicit user authorization to publish; requires --release-tag and never uploads')
parser.add_argument('--output', type=Path, default=ROOT / 'dist')
args = parser.parse_args()
if args.publication_ready and not args.release_tag:
    parser.error('--publication-ready requires --release-tag')
output = args.output.resolve()
allowed = {'.codex-plugin', '.github', 'assets', 'desktop', 'docs', 'lib', 'runtime', 'scripts', 'skills', 'tests', 'vendor'}
root_files = {'.mcp.json', '.gitignore', '.gitattributes', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'RELEASE_NOTES.md', 'PROVENANCE.md', 'SECURITY.md'}
blocked = {'node_modules', '.git', 'dist', 'qa', 'qa-output', 'backups', 'desktop-profile', 'desktop-runtime', '__pycache__', 'archive', 'packages'}
private_names = {'auth.json', 'config.toml', 'api-settings.json', 'usage-settings.json', 'runtime.json', 'service.lock', 'installation.json', 'ui-state.json', 'follow-state.json', 'last-turn.json', 'turn-journal.json', 'follow-config.json', 'follow-install.json', 'desktop-enabled.json', 'desktop-shutdown.json', '.dshw-size.json', '.dshw-bubble.json', 'display-mode.json'}
private_ext = {'.log', '.jsonl', '.db', '.sqlite', '.sqlite3', '.pem', '.key', '.pfx', '.bak', '.tmp', '.mp4', '.exe', '.dll', '.zip', '.7z', '.rar', '.tar', '.gz'}
text_ext = {'.json', '.js', '.mjs', '.cjs', '.md', '.ps1', '.cmd', '.command', '.swift', '.txt', '.html', '.css', '.cs', '.py', '.yml', '.yaml', '.ts', '.toml', '.ini'}
media_ext = {'.png', '.gif', '.mp3', '.wav'}
patterns = [re.compile(r'[A-Z]:[/\\]+(?:Users[/\\]+[^/\\\s<>"\']+[/\\]|Codex_work(?:place)?(?:[/\\]|\b)|QQ[/\\]+downloads)', re.I),
            re.compile(r'/(?:Users|home)/[^/\s<>"\']+/', re.I),
            re.compile(r'any' + r'router', re.I), re.compile(r'sk-[A-Za-z0-9_-]{24,}'),
            re.compile(r'codex-clipboard-[0-9a-f-]{30,}', re.I), re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}'),
            re.compile(r'github_pat_[A-Za-z0-9_]{30,}'), re.compile(r'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}')]
removed = []

def sanitize_gif(name, data):
    """Drop non-rendering comments/XMP; retain frame data and loop controls."""
    assert len(data) >= 14, 'Invalid GIF: ' + name
    offset = 13 + (3 * (2 ** ((data[10] & 7) + 1)) if data[10] & 0x80 else 0)
    assert offset < len(data), 'Invalid GIF color table: ' + name
    parts, kinds = [data[:offset]], []

    def subblocks(index):
        while True:
            assert index < len(data), 'Truncated GIF: ' + name
            size = data[index]
            index += 1
            assert index + size <= len(data), 'Truncated GIF sub-block: ' + name
            index += size
            if not size:
                return index

    while offset < len(data):
        start, tag = offset, data[offset]
        if tag == 0x3b:
            assert offset + 1 == len(data), 'Unexpected GIF trailing data: ' + name
            parts.append(data[offset:])
            return b''.join(parts), kinds
        if tag == 0x21:
            assert offset + 2 < len(data), 'Invalid GIF extension: ' + name
            label = data[offset + 1]
            offset = subblocks(offset + 2)
            if label == 0xfe:
                kinds.append('GIF-comment')
                continue
            if label == 0xff and data[start + 2] == 11 and data[start + 3:start + 14] == b'XMP DataXMP':
                kinds.append('GIF-XMP')
                continue
            if label == 0xff:
                assert data[start + 3:start + 14] in {b'NETSCAPE2.0', b'ANIMEXTS1.0'}, 'Review unknown GIF application metadata: ' + name
        elif tag == 0x2c:
            assert offset + 10 < len(data), 'Invalid GIF image: ' + name
            packed = data[offset + 9]
            offset += 10 + (3 * (2 ** ((packed & 7) + 1)) if packed & 0x80 else 0)
            offset = subblocks(offset + 1)
        else:
            raise AssertionError('Unknown GIF block: ' + name)
        parts.append(data[start:offset])
    raise AssertionError('Missing GIF trailer: ' + name)


def sanitize(name, data):
    kinds = []
    if data.startswith((b'GIF87a', b'GIF89a')):
        data, kinds = sanitize_gif(name, data)
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        parts = [data[:8]]
        offset = 8
        while offset < len(data):
            size = struct.unpack('>I', data[offset:offset+4])[0]
            end = offset + size + 12
            assert end <= len(data), 'Invalid PNG: ' + name
            kind = data[offset+4:offset+8]
            if kind in {b'eXIf', b'iTXt', b'tEXt', b'zTXt'}:
                kinds.append(kind.decode('ascii'))
            else:
                parts.append(data[offset:end])
            offset = end
        data = b''.join(parts)  # IDAT bytes remain unchanged: no pixel recompression.
    if name.endswith('.mp3'):
        assert not any(marker in data for marker in (b'APETAGEX', b'LYRICSBEGIN', b'LYRICS200')), 'Review audio trailing metadata: ' + name
        while data.startswith(b'ID3'):
            assert len(data) >= 10 and all(n < 128 for n in data[6:10]), 'Invalid ID3: ' + name
            size = sum(n << shift for n, shift in zip(data[6:10], [21, 14, 7, 0]))
            end = 10 + size + (10 if data[3] == 4 and data[5] & 16 else 0)
            assert end <= len(data), 'Invalid ID3 length: ' + name
            # Do not silently discard an embedded license or copyright notice.
            assert not any(k in data[10:end] for k in (b'TCOP', b'WCOP')), 'License metadata requires review: ' + name
            kinds.append('ID3v2'); data = data[end:]
        if len(data) >= 128 and data[-128:-125] == b'TAG':
            kinds.append('ID3v1'); data = data[:-128]
    if kinds:
        removed.append({'path': name, 'removedMetadata': sorted(set(kinds))})
    return data

files = {}
for file in sorted(ROOT.rglob('*')):
    if not file.is_file():
        continue
    rel = file.relative_to(ROOT)
    name = rel.as_posix()
    if file.resolve().is_relative_to(output):
        continue
    # The vendored parser's dist folder is a required runtime dependency.
    if any(p in blocked - {'dist'} or p.startswith(('qa-', 'private-')) for p in rel.parts):
        continue
    if rel.parts[0] == 'dist' or name.startswith('docs/images/'):
        continue
    assert not file.is_symlink(), 'Unexpected symlink: ' + name
    assert rel.parts[0] in allowed or name in root_files or len(rel.parts) == 1 and file.suffix in {'.cmd', '.command'}, 'Unexpected file: ' + name
    assert file.name not in private_names and not file.name.startswith('.env') and file.suffix.lower() not in private_ext, 'Private or binary file: ' + name
    assert file.suffix.lower() in text_ext | media_ext or file.name in {'.gitattributes', '.gitignore', 'LICENSE', 'NOTICE'}, 'Unexpected file type: ' + name
    assert 'rollback-target' not in file.name and not file.name.endswith('-installation.json'), 'Private receipt: ' + name
    data = sanitize(name, file.read_bytes())
    # Match .gitattributes independent of the OS/check-out line-ending policy.
    # Windows entrypoints keep CRLF; ordinary source and Mac launchers use LF.
    if file.suffix.lower() in text_ext or file.name in {'.gitattributes', '.gitignore', 'LICENSE'}:
        data = data.replace(b'\r\n', b'\n')
        if file.suffix.lower() in {'.cmd', '.ps1'}:
            data = data.replace(b'\n', b'\r\n')
        if file.suffix.lower() == '.ps1':
            # Windows PowerShell 5.1 otherwise treats UTF-8 source as the local
            # ANSI code page. Preserve Chinese messages and quoted paths.
            data = b'\xef\xbb\xbf' + data.removeprefix(b'\xef\xbb\xbf')
    if file.suffix.lower() in text_ext or file.name in {'.gitattributes', '.gitignore', 'LICENSE', 'NOTICE'}:
        content = data.decode('utf-8-sig').replace('\\\\', '\\')
        for pattern in patterns:
            assert not pattern.search(content), 'Privacy review required: ' + name
    files[name] = data

manifest = json.loads(files['.codex-plugin/plugin.json'].decode('utf-8-sig'))
version = manifest['version']
assert manifest['name'] == 'api-balance-whale' and re.fullmatch(r'\d+\.\d+\.\d+', version), 'Release version must be stable semver'
package = json.loads(files['package.json'])
distribution = package.get('distributionName', 'api-balance-whale-v' + version)
assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,79}', distribution), 'Invalid distribution name'
lock = json.loads(files['package-lock.json'])
runtime = files['runtime/paths.mjs'].decode('utf-8-sig')
assert package['version'] == lock['version'] == lock['packages']['']['version'] == version, 'Package version mismatch'
assert re.search(r"export const VERSION = ['\"]" + re.escape(version) + r"['\"]", runtime), 'Runtime version mismatch'
if args.release_tag:
    assert args.release_tag == 'codex-v' + version, 'Codex release tag/version mismatch'
assert manifest['author']['name'] == 'Yang-huai406'
for name in ['vendor/smol-toml/dist/index.js', 'desktop/ui/dashboard.js', 'desktop/ui/shape.js', 'desktop/macos/window-probe.swift', 'scripts/install-package.ps1', 'scripts/install-macos.mjs']:
    assert name in files, 'Missing runtime dependency: ' + name
assert b'pull/128' in files['README.md']
links = 0
for name, data in files.items():
    if not name.endswith('.md') or name.startswith('vendor/') or name == 'docs/UPSTREAM-README.md':
        continue
    for target in re.findall(r'\]\(([^\n)]+)\)', data.decode('utf-8-sig')):
        target = target.strip('<>').split('#')[0]
        if not target or '://' in target or target.startswith('mailto:'):
            continue
        resolved = ((ROOT / name).parent / unquote(target)).resolve()
        assert resolved.is_relative_to(ROOT) and resolved.relative_to(ROOT).as_posix() in files, 'Broken public link: ' + name + ': ' + target
        links += 1

output.mkdir(parents=True, exist_ok=True)
def archive(name, selected):
    destination = output / name
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for relative, data in selected.items():
            info = zipfile.ZipInfo('api-balance-whale/' + relative, (2026, 10, 5, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED; info.create_system = 3
            info.external_attr = (0o100755 if relative.endswith('.command') else 0o100644) << 16
            z.writestr(info, data)
    with zipfile.ZipFile(destination) as z:
        assert z.testzip() is None
        for relative, data in selected.items():
            assert z.read('api-balance-whale/' + relative) == data
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    (output / (name + '.sha256')).write_text(digest + '  ' + name + '\n', encoding='utf-8')
    return {'name': name, 'sha256': digest, 'bytes': destination.stat().st_size, 'files': len(selected)}

artifacts = [archive(distribution + '.zip', {p: d for p, d in files.items() if not p.startswith(('.github/', 'tests/'))}),
             archive(distribution + '-source.zip', files)]
report = {'displayVersion': 'v' + version, 'internalVersion': version, 'candidateRevision': package.get('codexBuild', ''), 'status': 'release-ready-user-authorized' if args.publication_ready else 'local-test-candidate-awaiting-user-acceptance', 'publicationReady': args.publication_ready, 'published': False,
          'publishedFieldScope': 'Local build time only; this script never publishes. Consult the GitHub Release for current publication status.',
          'distributionName': distribution,
          'lineEndings': 'LF for source and Mac launchers; CRLF for Windows .cmd/.ps1; UTF-8 BOM for Windows PowerShell',
          'releaseTag': args.release_tag, 'offlineInstaller': False, 'macOS': 'static-checks-no-hardware-acceptance', 'subscriptionLiveAccount': 'unverified',
          'macOSPR': 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/128',
          'privacyScan': 'passed-public-files-only', 'archiveIntegrity': 'passed', 'localLinksChecked': links,
          'excluded': ['user data and credentials', 'private installation receipts', 'logs and test output', 'chat screenshots and recordings', 'legacy docs/images', 'git history and runtime caches'],
          'mediaMetadataSanitized': removed, 'artifacts': artifacts,
          'contentHashes': {p: hashlib.sha256(d).hexdigest() for p, d in files.items()}}
(output / 'release-manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({k: v for k, v in report.items() if k != 'contentHashes'}, ensure_ascii=False))
