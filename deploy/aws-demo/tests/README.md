# Container cleanup tests

From the repository root, run `python -m unittest discover -s deploy/aws-demo/tests -p test_container_cleanup.py`.
The tests use a fake Docker daemon and temporary files to check the 15-minute threshold, container ownership, archival and removal after a final state check.
