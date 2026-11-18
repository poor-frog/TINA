import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).parents[1] / 'container-cleanup.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
CID = 'a' * 64
NETWORK = 'test_tina'


def container():
    return {'Id': CID, 'Name': '/tina-mtg-1-fixture', 'RestartCount': 0, 'SizeRw': 10,
            'Config': {'Labels': {'runtime.managed': 'true'}},
            'State': {'Status': 'exited', 'Running': False, 'ExitCode': 0,
                      'StartedAt': '2026-01-01T00:00:00Z',
                      'FinishedAt': (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).isoformat()},
            'HostConfig': {'NetworkMode': NETWORK}, 'Mounts': []}


class FakeDocker:
    def __init__(self, c=None):
        self.c = c or container()
        self.removed = []
        self.files = {'/tmp/recording/audio.wav': b'private recording',
                      '/root/.cache/model.bin': b'cached model'}

    def candidates(self, network):
        return [CID]

    def inspect(self, cid):
        return copy.deepcopy(self.c)

    def changes(self, cid):
        return [{'Path': path, 'Kind': 1} for path in self.files]

    def is_directory(self, cid, path):
        return False

    @contextlib.contextmanager
    def archive(self, cid, path):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as tar:
            item = tarfile.TarInfo(Path(path).name)
            item.size = len(self.files[path])
            tar.addfile(item, io.BytesIO(self.files[path]))
        buffer.seek(0)
        yield buffer

    def logs_to(self, cid, path, max_bytes):
        if max_bytes < 11:
            raise cleanup.DockerError('budget')
        path.write_bytes(b'fixture log')

    def remove(self, cid):
        self.removed.append(cid)


class PolicyTests(unittest.TestCase):
    def test_only_owned_stopped_old_container_on_selected_network(self):
        c = container()
        now = dt.datetime.now(dt.timezone.utc)
        self.assertTrue(cleanup.eligible(c, NETWORK, now, cleanup.DEFAULT_MIN_AGE_SECONDS))
        alternatives = []
        for label in ('com.amazonaws.ecs.task-arn', 'com.docker.compose.service'):
            wrong = copy.deepcopy(c); wrong['Config']['Labels'][label] = 'fixture'; alternatives.append(wrong)
        wrong = copy.deepcopy(c); wrong['Config']['Labels'] = {}; alternatives.append(wrong)
        wrong = copy.deepcopy(c); wrong['HostConfig']['NetworkMode'] = 'other'; alternatives.append(wrong)
        wrong = copy.deepcopy(c); wrong['Name'] = '/tina-storage-init'; alternatives.append(wrong)
        wrong = copy.deepcopy(c); wrong['State']['Status'] = 'running'; alternatives.append(wrong)
        wrong = copy.deepcopy(c); wrong['State']['Running'] = True; alternatives.append(wrong)
        wrong = copy.deepcopy(c); wrong['State']['FinishedAt'] = now.isoformat(); alternatives.append(wrong)
        wrong = copy.deepcopy(c); wrong['State']['FinishedAt'] = '0001-01-01T00:00:00Z'; alternatives.append(wrong)
        for wrong in alternatives:
            with self.subTest(wrong=wrong):
                self.assertFalse(cleanup.eligible(wrong, NETWORK, now, cleanup.DEFAULT_MIN_AGE_SECONDS))

    def test_fifteen_minute_grace_period(self):
        c = container()
        now = dt.datetime.now(dt.timezone.utc)
        for seconds, expected in ((899, False), (900, True)):
            with self.subTest(seconds=seconds):
                c['State']['FinishedAt'] = (now - dt.timedelta(seconds=seconds)).isoformat()
                self.assertEqual(cleanup.eligible(c, NETWORK, now, cleanup.DEFAULT_MIN_AGE_SECONDS), expected)

    def test_nanosecond_docker_timestamp_on_python39(self):
        c = container(); c['State']['FinishedAt'] = '2026-01-01T01:02:03.123456789Z'
        self.assertEqual(cleanup.finished_at(c).microsecond, 123456)

    def test_mount_parents_never_copy_persistent_workspace(self):
        changes = [{'Path': '/workspaces', 'Kind': 1}, {'Path': '/workspaces/4', 'Kind': 1},
                   {'Path': '/workspaces/4/repo', 'Kind': 1}, {'Path': '/workspaces/local.txt', 'Kind': 1},
                   {'Path': '/tmp/job', 'Kind': 1}, {'Path': '/tmp/job/a.wav', 'Kind': 1},
                   {'Path': '/gone', 'Kind': 2}]
        paths = cleanup.archive_paths(changes, ['/workspaces/4'])
        self.assertEqual(paths, [('/tmp/job', 1), ('/workspaces/local.txt', 1)])

    def test_dry_run_does_not_archive_or_delete(self):
        docker = FakeDocker()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cleanup, 'preserve') as preserve:
            result = cleanup.clean(docker, NETWORK, Path(tmp))
        self.assertEqual(result['eligible'], 1)
        self.assertEqual(docker.removed, [])
        preserve.assert_not_called()


class PreservationTests(unittest.TestCase):
    def test_recording_model_and_logs_survive_removal(self):
        docker = FakeDocker()
        with tempfile.TemporaryDirectory() as tmp:
            result = cleanup.clean(docker, NETWORK, Path(tmp), apply=True, reserve_bytes=0)
            self.assertEqual(result['removed'], 1)
            manifest_path = next(Path(tmp).rglob('manifest.json'))
            manifest = json.loads(manifest_path.read_text())
            self.assertTrue(manifest['complete'])
            with tarfile.open(manifest_path.parent / 'writable-files.tar.gz') as tar:
                self.assertEqual(tar.extractfile('tmp/recording/audio.wav').read(), b'private recording')
                self.assertEqual(tar.extractfile('root/.cache/model.bin').read(), b'cached model')
            self.assertEqual((manifest_path.parent / 'container.log').read_bytes(), b'fixture log')
            self.assertEqual(docker.removed, [CID])

    def test_archive_failure_never_deletes_container(self):
        docker = FakeDocker()
        with tempfile.TemporaryDirectory() as tmp, patch.object(docker, 'archive', side_effect=OSError('fixture')):
            result = cleanup.clean(docker, NETWORK, Path(tmp), apply=True, reserve_bytes=0)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(docker.removed, [])

    def test_container_restart_during_archive_prevents_delete(self):
        docker = FakeDocker()
        original = docker.inspect(CID)
        running = copy.deepcopy(original); running['State']['Status'] = 'running'
        with tempfile.TemporaryDirectory() as tmp, patch.object(cleanup, 'preserve'), \
                patch.object(docker, 'inspect', side_effect=[original, running]):
            result = cleanup.clean(docker, NETWORK, Path(tmp), apply=True)
        self.assertEqual(result['kept'], 1)
        self.assertEqual(docker.removed, [])

    def test_size_budget_failure_keeps_container(self):
        docker = FakeDocker()
        with tempfile.TemporaryDirectory() as tmp:
            result = cleanup.clean(docker, NETWORK, Path(tmp), apply=True, max_bytes=1, reserve_bytes=0)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(docker.removed, [])

    def test_missing_container_is_a_benign_runtime_race(self):
        docker = FakeDocker()
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(docker, 'inspect', side_effect=cleanup.DockerError('gone', 404)):
            result = cleanup.clean(docker, NETWORK, Path(tmp), apply=True)
        self.assertEqual(result['failed'], 0)
        self.assertEqual(docker.removed, [])

    def test_low_disk_space_keeps_container(self):
        docker = FakeDocker()
        with tempfile.TemporaryDirectory() as tmp, patch.object(cleanup.shutil, 'disk_usage') as disk:
            disk.return_value.free = 5
            result = cleanup.clean(docker, NETWORK, Path(tmp), apply=True, reserve_bytes=0)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(docker.removed, [])

    def test_removal_uses_exact_id_and_selected_daemon_without_force_or_volumes(self):
        with patch.object(cleanup.subprocess, 'run') as run:
            run.return_value.returncode = 0
            cleanup.Docker('/run/fixture.sock').remove(CID)
        self.assertEqual(run.call_args.args[0], ['docker', '--host', 'unix:///run/fixture.sock', 'rm', CID])


if __name__ == '__main__':
    unittest.main()
