#!/usr/bin/env python3
"""Archive and remove expired, stopped TINA runtime containers on one Docker network."""
import argparse
import base64
import contextlib
import copy
import datetime as dt
import gzip
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import subprocess
import tarfile
from urllib.parse import urlencode

DEFAULT_MIN_AGE_SECONDS = 15 * 60
MANAGED = 'runtime.managed'
PREFIXES = ('tina-mtg-', 'tina-worker-', 'tina-agent-')
DIRECTORY = 1 << 31  # Docker's PathStat.mode uses Go FileMode, not POSIX st_mode.


class DockerError(RuntimeError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=60)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class Docker:
    def __init__(self, path='/var/run/docker.sock'):
        self.path = path

    @contextlib.contextmanager
    def request(self, method, path):
        conn = UnixHTTP(self.path)
        try:
            conn.request(method, path)
            response = conn.getresponse()
            if response.status != 200:
                raise DockerError('Docker API HTTP ' + str(response.status), response.status)
            yield response
        finally:
            conn.close()

    def candidates(self, network):
        filters = {'label': [MANAGED + '=true'], 'status': ['exited'], 'network': [network]}
        with self.request('GET', '/containers/json?' + urlencode({'all': '1', 'filters': json.dumps(filters)})) as r:
            return [c['Id'] for c in json.load(r)]

    def inspect(self, cid):
        with self.request('GET', '/containers/' + cid + '/json?size=1') as r:
            return json.load(r)

    def changes(self, cid):
        with self.request('GET', '/containers/' + cid + '/changes') as r:
            return json.load(r) or []

    @staticmethod
    def archive_url(cid, path):
        return '/containers/' + cid + '/archive?' + urlencode({'path': path})

    def is_directory(self, cid, path):
        with self.request('HEAD', self.archive_url(cid, path)) as r:
            data = json.loads(base64.b64decode(r.getheader('X-Docker-Container-Path-Stat')))
            return bool(data['mode'] & DIRECTORY)

    def archive(self, cid, path):
        return self.request('GET', self.archive_url(cid, path))

    def logs_to(self, cid, target, max_bytes):
        with target.open('wb') as output:
            process = subprocess.Popen(['docker', '--host', 'unix://' + self.path,
                                        'logs', '--timestamps', cid], stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT)
            try:
                written = 0
                for chunk in iter(lambda: process.stdout.read(65536), b''):
                    written += len(chunk)
                    if written > max_bytes:
                        raise DockerError('Container log archive exceeds size budget')
                    output.write(chunk)
                if process.wait(timeout=30):
                    raise DockerError('Container log archival failed')
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()  # Only the local logs CLI, never a container.
                        process.wait()
                process.stdout.close()
            output.flush()
            os.fsync(output.fileno())

    def remove(self, cid):
        # The daemon refuses a running container. Never force deletion or remove volumes.
        result = subprocess.run(['docker', '--host', 'unix://' + self.path, 'rm', cid],
                                capture_output=True, text=True)
        if result.returncode:
            raise DockerError('Container removal refused')


def finished_at(c):
    raw = c.get('State', {}).get('FinishedAt', '')
    try:
        stamp = dt.datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', raw).replace('Z', '+00:00'))
        return stamp if stamp.tzinfo and stamp.year >= 2000 else None
    except ValueError:
        return None


def eligible(c, network, now, min_age):
    labels = c.get('Config', {}).get('Labels') or {}
    state = c.get('State') or {}
    host = c.get('HostConfig') or {}
    stamp = finished_at(c)
    return (bool(re.fullmatch(r'[0-9a-f]{64}', c.get('Id', '')))
            and c.get('Name', '').lstrip('/').startswith(PREFIXES)
            and labels.get(MANAGED) == 'true'
            and not any(k.startswith('com.amazonaws.ecs.') or k.startswith('com.docker.compose.') for k in labels)
            and state.get('Status') == 'exited' and not state.get('Running')
            and host.get('NetworkMode') == network
            and stamp is not None and (now - stamp).total_seconds() >= min_age)


def identity(c):
    return {k: c.get('State', {}).get(k) for k in ('StartedAt', 'FinishedAt', 'ExitCode')} | {
        'Id': c['Id'], 'RestartCount': c.get('RestartCount', 0)}


def below(path, root):
    return path == root or path.startswith(root.rstrip('/') + '/')


def archive_paths(changes, mounts):
    """Group added subtrees, but never cross a persistent-volume mount boundary."""
    result, added = [], []
    for change in sorted(changes, key=lambda c: (len(PurePosixPath(c['Path']).parts), c['Path'])):
        path, kind = change['Path'], change['Kind']
        if not path.startswith('/') or '..' in PurePosixPath(path).parts:
            raise ValueError('Invalid Docker change path')
        if kind == 2 or path == '/' or any(below(path, m) for m in mounts):
            continue
        if any(below(path, parent) for parent in added):
            continue
        if any(below(m, path) for m in mounts):
            continue  # Walk descendant diff entries instead of copying a volume through its parent.
        result.append((path, kind))
        if kind == 1:
            added.append(path)
    return result


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def sync_directory(path):
    if os.name == 'posix':
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def preserve(docker, c, state_dir, max_bytes, reserve_bytes):
    fingerprint = identity(c)
    key = hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()[:20]
    folder = state_dir / 'archives' / c['Id'] / key
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest_path = folder / 'manifest.json'
    if manifest_path.exists():
        saved = json.loads(manifest_path.read_text())
        if (saved.get('identity') == fingerprint and saved.get('complete')
                and all((folder / name).is_file() and sha256(folder / name) == digest
                        for name, digest in saved['sha256'].items())):
            return folder
        raise RuntimeError('Existing archive is incomplete or changed')
    free = shutil.disk_usage(state_dir).free
    if free <= reserve_bytes + max(0, c.get('SizeRw', 0)):
        raise RuntimeError('Insufficient space to preserve container data')
    max_bytes = min(max_bytes, free - reserve_bytes)
    changes = docker.changes(c['Id'])
    mounts = [m['Destination'].rstrip('/') or '/' for m in c.get('Mounts', [])]
    paths = archive_paths(changes, mounts)
    written, members = 0, 0
    payload = folder / 'writable-files.tar.gz'
    with payload.open('wb') as output:
        # Explicit gzip wrapper keeps streaming compatible with the EC2 host's Python 3.9.
        with gzip.GzipFile(fileobj=output, mode='wb', compresslevel=3, mtime=0) as zipped, \
                tarfile.open(fileobj=zipped, mode='w|') as dest:
            for path, kind in paths:
                if kind == 0 and docker.is_directory(c['Id'], path):
                    continue
                with docker.archive(c['Id'], path) as response:
                    with tarfile.open(fileobj=response, mode='r|') as source:
                        for member in source:
                            item = copy.copy(member)
                            rel = PurePosixPath(item.name)
                            if rel.is_absolute() or '..' in rel.parts:
                                raise RuntimeError('Unsafe archive member')
                            name = PurePosixPath(path).parent / rel
                            if any(below('/' + str(name).lstrip('/'), mount) for mount in mounts):
                                raise RuntimeError('Archive unexpectedly includes a mounted volume')
                            item.name = str(name).lstrip('/')
                            if item.islnk():
                                link = PurePosixPath(item.linkname)
                                if link.is_absolute() or '..' in link.parts:
                                    raise RuntimeError('Unsafe archive hardlink')
                                item.linkname = str(PurePosixPath(path).parent / link).lstrip('/')
                            if item.isdev():
                                continue
                            written += item.size
                            if written > max_bytes:
                                raise RuntimeError('Container archive exceeds size budget')
                            dest.addfile(item, source.extractfile(member) if member.isfile() else None)
                            members += 1
        output.flush()
        os.fsync(output.fileno())
    logs = folder / 'container.log'
    docker.logs_to(c['Id'], logs, max_bytes - written)
    if logs.stat().st_size + written > max_bytes:
        raise RuntimeError('Container logs exceed archive size budget')
    saved = {'complete': True, 'identity': fingerprint, 'name': c['Name'],
             'archived_members': members, 'uncompressed_file_bytes': written,
             'mounts_preserved': mounts, 'changes': changes,
             'sha256': {p.name: sha256(p) for p in (payload, logs)}}
    pending = folder / 'manifest.pending'
    with pending.open('w') as f:
        json.dump(saved, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    pending.replace(manifest_path)
    for parent in (folder, folder.parent, folder.parent.parent, state_dir):
        sync_directory(parent)
    return folder


def clean(docker, network, state_dir, min_age=DEFAULT_MIN_AGE_SECONDS, apply=False,
          now=None, max_containers=100, max_bytes=2 * 1024**3,
          reserve_bytes=1024**3, only_ids=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    result = {'eligible': 0, 'removed': 0, 'kept': 0, 'failed': 0}
    for cid in docker.candidates(network):
        if only_ids and cid not in only_ids:
            continue
        if not re.fullmatch(r'[0-9a-f]{64}', cid):
            continue
        try:
            c = docker.inspect(cid)
            if not eligible(c, network, now, min_age):
                continue
            result['eligible'] += 1
            if not apply or result['removed'] >= max_containers:
                result['kept'] += 1
                continue
            preserve(docker, c, state_dir, max_bytes, reserve_bytes)
            current = docker.inspect(cid)
            if (identity(current) != identity(c)
                    or not eligible(current, network, dt.datetime.now(dt.timezone.utc), min_age)):
                result['kept'] += 1
                continue
            docker.remove(cid)
            result['removed'] += 1
            print(json.dumps({'event': 'removed', 'container_id': cid}), flush=True)
        except Exception as error:
            # Keep private logs, environment and response bodies out of the system journal.
            if isinstance(error, DockerError) and error.status == 404:
                result['kept'] += 1
                continue  # Runtime independently removed this exact container.
            result['failed'] += 1
            print(json.dumps({'event': 'kept', 'container_id': cid, 'error_type': type(error).__name__}), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--network', required=True, help='Exact runtime DOCKER_NETWORK on this host')
    parser.add_argument('--socket', default='/var/run/docker.sock')
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/tina/container-cleanup'))
    parser.add_argument('--min-age-seconds', type=int, default=DEFAULT_MIN_AGE_SECONDS)
    parser.add_argument('--max-containers', type=int, default=100)
    parser.add_argument('--container-id', action='append', help='Restrict an operator check to exact container IDs')
    parser.add_argument('--apply', action='store_true', help='Archive then remove; otherwise report counts only')
    args = parser.parse_args()
    if args.min_age_seconds < 0 or args.max_containers < 1:
        parser.error('Age must be non-negative and maximum container count positive')
    if args.container_id and any(not re.fullmatch(r'[0-9a-f]{64}', c) for c in args.container_id):
        parser.error('Container IDs must be full 64-character hexadecimal IDs')
    os.umask(0o077)
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.state_dir.is_symlink() or args.state_dir.stat().st_uid != os.geteuid():
        raise RuntimeError('Cleanup state directory must be owned by the current operator')
    args.state_dir.chmod(0o700)
    import fcntl  # Host-only Linux command; policy and archive helpers can also be tested on Windows.
    with (args.state_dir / 'cleanup.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'event': 'already_running'}))
            return 0
        result = clean(Docker(args.socket), args.network, args.state_dir,
                       min_age=args.min_age_seconds, apply=args.apply,
                       max_containers=args.max_containers, only_ids=args.container_id)
        print(json.dumps({'event': 'summary', **result}), flush=True)
        return 1 if result['failed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
