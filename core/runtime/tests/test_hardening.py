"""Tests for Sandbox hardening: egress allowlist proxy, per-owner/global quotas, and idle reaper."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch
import pytest

from runtime_kernel.backend import WorkloadHandle
from runtime_kernel.clock import FakeClock
from runtime_kernel.egress_proxy import (
    DEFAULT_ALLOWLIST,
    EgressAllowlistProxy,
    host_allowed,
    is_public_ip,
    parse_allowlist,
)
from runtime_kernel.enforcement import Enforcer
from runtime_kernel.kernel import QuotaExceeded, Runtime
from runtime_kernel.models import RuntimeState, StopReason, WorkloadSpec
from runtime_kernel.profiles import Profile, ProfileRegistry, Runnable


class _FakeBackend:
    name = "ecs"
    stop_poll_interval = 0.0

    def __init__(self) -> None:
        self.exited: dict[str, int] = {}
        self.terminated: list[str] = []

    def start(self, workload_id, runnable, env, resources=None):
        return WorkloadHandle(workload_id, workload_id)

    def exit_code(self, handle):
        return self.exited.get(handle.id)

    def terminate(self, handle):
        self.terminated.append(handle.id)
        self.exited[handle.id] = 0

    def kill(self, handle):
        self.exited[handle.id] = 137


class _MemWriter:
    def __init__(self) -> None:
        self.buf = bytearray()
        self.closed = False

    def write(self, data: bytes) -> None:
        self.buf.extend(data)

    async def drain(self) -> None:
        return None

    def can_write_eof(self) -> bool:
        return False

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None

    def get_extra_info(self, name: str, default=None):
        if name == "peername":
            return ("10.42.10.99", 54321)
        return default


def _reader_with(payload: bytes) -> asyncio.StreamReader:
    r = asyncio.StreamReader()
    r.feed_data(payload)
    r.feed_eof()
    return r


def test_egress_allowlist_and_anti_ssrf_ip_checks():
    allow = parse_allowlist(None)
    assert allow == DEFAULT_ALLOWLIST
    assert host_allowed("bedrock-runtime.us-east-1.amazonaws.com", allow)
    assert host_allowed("bedrock-runtime.us-west-2.amazonaws.com", allow)
    assert host_allowed("api.anthropic.com", allow)
    assert host_allowed("api.openai.com", allow)
    assert host_allowed("raw.githubusercontent.com", allow)
    assert host_allowed("github.com", allow)
    # Disallowed domains and raw IPs must be rejected
    assert not host_allowed("evil.example.com", allow)
    assert not host_allowed("169.254.169.254", allow)
    assert not host_allowed("10.42.10.5", allow)
    assert not host_allowed("github.com.evil.org", allow)
    # Private / loopback / metadata IPs blocked by is_public_ip
    assert not is_public_ip("10.42.0.2")
    assert not is_public_ip("172.16.0.1")
    assert not is_public_ip("192.168.1.1")
    assert not is_public_ip("169.254.169.254")
    assert not is_public_ip("169.254.170.2")
    assert not is_public_ip("127.0.0.1")
    assert not is_public_ip("::1")
    assert is_public_ip("140.82.112.4")


def test_egress_proxy_health_deny_ssrf_and_connect_tunnel():
    async def _run():
        proxy = EgressAllowlistProxy(allowlist=("api.anthropic.com", "github.com"))

        # 1. GET /health -> 200 ok
        w = _MemWriter()
        await proxy.handle_client(_reader_with(b"GET /health HTTP/1.1\r\nHost: proxy\r\n\r\n"), w)
        assert b"200 OK" in w.buf and bytes(w.buf).endswith(b"ok")

        # 2. Disallowed domain -> 403 Forbidden
        w = _MemWriter()
        await proxy.handle_client(_reader_with(b"CONNECT evil.example:443 HTTP/1.1\r\n\r\n"), w)
        assert b"403 Forbidden" in w.buf

        # 3. Disallowed port -> 403 Forbidden
        w = _MemWriter()
        await proxy.handle_client(_reader_with(b"CONNECT api.anthropic.com:22 HTTP/1.1\r\n\r\n"), w)
        assert b"403 Forbidden" in w.buf

        # 4. Plain HTTP proxy request -> 403 Forbidden
        w = _MemWriter()
        await proxy.handle_client(_reader_with(b"GET http://api.anthropic.com/ HTTP/1.1\r\n\r\n"), w)
        assert b"403 Forbidden" in w.buf

        # 5. DNS rebinding to private VPC IP -> 403 Forbidden
        with patch(
            "runtime_kernel.egress_proxy.resolve_public_ip",
            new=AsyncMock(side_effect=ValueError("blocked_private_ip:10.42.10.8")),
        ):
            w = _MemWriter()
            await proxy.handle_client(_reader_with(b"CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n"), w)
            assert b"403 Forbidden" in w.buf

        # 6. Allowed host + verified public IP -> 200 Connection Established + bidirectional relay
        upstream_reader = _reader_with(b"TLS-SERVER-HELLO")
        upstream_writer = _MemWriter()
        with (
            patch("runtime_kernel.egress_proxy.resolve_public_ip", new=AsyncMock(return_value=("160.79.104.10", 443))),
            patch("asyncio.open_connection", new=AsyncMock(return_value=(upstream_reader, upstream_writer))),
        ):
            client_reader = _reader_with(b"CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\nTLS-CLIENT-HELLO")
            client_writer = _MemWriter()
            await proxy.handle_client(client_reader, client_writer)
            assert b"200 Connection Established\r\n\r\nTLS-SERVER-HELLO" in bytes(client_writer.buf)
            assert bytes(upstream_writer.buf) == b"TLS-CLIENT-HELLO"

    asyncio.run(_run())


def test_owner_quota_global_quota_and_idle_reaper():
    clock = FakeClock(1000.0)
    backend = _FakeBackend()
    profiles = ProfileRegistry({
        "workspace-agent": Profile(
            name="workspace-agent",
            runnable=Runnable(image="img", command=["python"]),
            idle_timeout_sec=300,
            max_lifetime_sec=900,
        ),
    })
    rt = Runtime(backend=backend, profiles=profiles, clock=clock, owner_quota=2, global_quota=3)
    enforcer = Enforcer(rt, clock=clock)
    rt.enforcer = enforcer

    # Owner 1 spawns 2 workloads (at owner_quota=2)
    rt.create(WorkloadSpec(workloadId="agent-1-chat-a", profile="workspace-agent", env={"TINA_OWNER": "1"}))
    rt.create(WorkloadSpec(workloadId="agent-1-chat-b", profile="workspace-agent", env={"TINA_OWNER": "1"}))
    # Keep-alive touch of existing workload never triggers 429 and resets idle timer
    clock.advance(200.0)
    rt.create(WorkloadSpec(workloadId="agent-1-chat-a", profile="workspace-agent", env={"TINA_OWNER": "1"}))
    # 3rd workload for owner 1 trips owner_quota
    with pytest.raises(QuotaExceeded) as exc_info:
        rt.create(WorkloadSpec(workloadId="agent-1-chat-c", profile="workspace-agent", env={"TINA_OWNER": "1"}))
    assert exc_info.value.owner == "1"

    # Owner 2 spawns 1 workload (total active = 3 == global_quota)
    rt.create(WorkloadSpec(workloadId="agent-2-chat-a", profile="workspace-agent", env={"TINA_OWNER": "2"}))
    # Owner 3 trips global_quota=3
    with pytest.raises(QuotaExceeded) as exc_global:
        rt.create(WorkloadSpec(workloadId="agent-3-chat-a", profile="workspace-agent", env={"TINA_OWNER": "3"}))
    assert exc_global.value.owner == "__global__"

    # Self-exited workload is auto-reflected so quota immediately frees up
    backend.exited["agent-2-chat-a"] = 0
    st3 = rt.create(WorkloadSpec(workloadId="agent-3-chat-a", profile="workspace-agent", env={"TINA_OWNER": "3"}))
    assert st3.state is RuntimeState.running

    # Advance 120s (total 320s since start, 120s since touch on chat-a):
    # chat-b has been idle 320s >= 300s -> reaped; chat-a (touched at t=1200) stays alive!
    clock.advance(120.0)
    stopped = enforcer.sweep()
    assert stopped == ["agent-1-chat-b"]
    assert rt.get("agent-1-chat-b").stopReason is StopReason.idle_timeout
    assert rt.get("agent-1-chat-a").state is RuntimeState.running
