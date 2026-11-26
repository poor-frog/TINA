"""Strict HTTPS CONNECT egress allowlist proxy for Fargate agent sandboxes.

Runs as a tiny standalone Fargate service (`egress-proxy.tina-staging.local:3128`)
with `ReadonlyRootFilesystem: true` and ZERO IAM/AWS permissions.

Security guarantees:
  1. Only HTTPS `CONNECT host:443` is permitted (all other ports and plain HTTP
     proxy requests return `403 Forbidden`).
  2. Hostnames must match `TINA_EGRESS_ALLOWLIST` (exact or wildcard `*.example.com`).
  3. DNS is resolved on the proxy and every resolved IP is verified public before
     connecting — blocking SSRF / DNS-rebinding to VPC private ranges, loopback,
     and ECS/EC2 metadata (`169.254.169.254`, `169.254.170.2`).
  4. Every allow/deny decision emits a structured CloudWatch log line (`EGRESS_ALLOW`
     / `EGRESS_DENY`) for audit and alerting.
"""
from __future__ import annotations

import asyncio
import fnmatch
import ipaddress
import logging
import os
import re
import signal
import socket
from typing import Iterable, Sequence

log = logging.getLogger("runtime_kernel.egress_proxy")

DEFAULT_ALLOWLIST: tuple[str, ...] = (
    # AWS Bedrock (including cross-region inference profiles)
    "bedrock-runtime.*.amazonaws.com",
    "bedrock.*.amazonaws.com",
    # LLM APIs (Anthropic / OpenAI / ChatGPT Plan / Gemini / Antigravity / Groq / DeepSeek)
    "api.anthropic.com",
    "api.openai.com",
    "chatgpt.com",
    "auth.openai.com",
    "generativelanguage.googleapis.com",
    "oauth2.googleapis.com",
    "cloudcode-pa.googleapis.com",
    "api.groq.com",
    "api.deepseek.com",
    "openrouter.ai",
    "api.together.xyz",
    "api.fireworks.ai",
    "api.mistral.ai",
    "api.x.ai",
    # GitHub (git clone / push / pull / release archives)
    "github.com",
    "api.github.com",
    "*.githubusercontent.com",
    "codeload.github.com",
    # Standard package registries for sandbox scripts
    "pypi.org",
    "files.pythonhosted.org",
    "registry.npmjs.org",
)

_HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
_CONNECT_TIMEOUT_SEC = 10.0
_RELAY_IDLE_TIMEOUT_SEC = 300.0
_MAX_HEADER_BYTES = 16384


def parse_allowlist(raw: str | None) -> tuple[str, ...]:
    if not raw or not raw.strip():
        return DEFAULT_ALLOWLIST
    items = [p.strip().lower().rstrip(".") for p in raw.split(",") if p.strip()]
    return tuple(items) if items else DEFAULT_ALLOWLIST


def host_allowed(host: str, allowlist: Sequence[str]) -> bool:
    norm = host.strip().lower().rstrip(".")
    if not norm or not _HOST_RE.match(norm):
        return False
    # Never allow raw IP literals through the domain allowlist
    try:
        ipaddress.ip_address(norm)
        return False
    except ValueError:
        pass
    for pattern in allowlist:
        pat = pattern.strip().lower().rstrip(".")
        if not pat:
            continue
        if "*" in pat:
            if fnmatch.fnmatchcase(norm, pat):
                return True
        elif norm == pat:
            return True
    return False


def is_public_ip(ip_str: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return bool(
        addr.is_global
        and not addr.is_private
        and not addr.is_loopback
        and not addr.is_link_local
        and not addr.is_multicast
        and not addr.is_reserved
        and not addr.is_unspecified
    )


async def resolve_public_ip(
    host: str,
    port: int,
    *,
    allow_non_public: bool = False,
) -> tuple[str, int]:
    """Resolve host and verify every returned IP is public (anti-SSRF / anti-DNS-rebinding)."""
    loop = asyncio.get_running_loop()
    infos = await asyncio.wait_for(
        loop.getaddrinfo(host, port, type=socket.SOCK_STREAM),
        timeout=_CONNECT_TIMEOUT_SEC,
    )
    if not infos:
        raise ValueError("dns_empty")
    ips: list[str] = []
    for _family, _type, _proto, _canon, sockaddr in infos:
        ip_str = str(sockaddr[0])
        if not allow_non_public and not is_public_ip(ip_str):
            raise ValueError(f"blocked_private_ip:{ip_str}")
        ips.append(ip_str)
    # Prefer IPv4 first when available (Fargate private subnets use IPv4 NAT)
    for ip_str in ips:
        if ":" not in ip_str:
            return ip_str, port
    return ips[0], port


async def _relay(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            chunk = await asyncio.wait_for(reader.read(65536), timeout=_RELAY_IDLE_TIMEOUT_SEC)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
        except (OSError, RuntimeError):
            pass


async def _send_http(writer: asyncio.StreamWriter, status: str, body: bytes = b"") -> None:
    hdr = (
        f"HTTP/1.1 {status}\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n\r\n"
    ).encode("ascii")
    writer.write(hdr + body)
    await writer.drain()


class EgressAllowlistProxy:
    def __init__(
        self,
        *,
        allowlist: Iterable[str] = DEFAULT_ALLOWLIST,
        allowed_ports: Iterable[int] = (443,),
        allow_non_public: bool = False,
    ) -> None:
        self.allowlist = tuple(p.strip().lower().rstrip(".") for p in allowlist if p.strip())
        self.allowed_ports = frozenset(allowed_ports)
        self.allow_non_public = allow_non_public

    async def handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        remote_writer: asyncio.StreamWriter | None = None
        peer = writer.get_extra_info("peername")
        peer_ip = peer[0] if isinstance(peer, tuple) and peer else "unknown"
        try:
            raw_head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10.0)
            if len(raw_head) > _MAX_HEADER_BYTES:
                await _send_http(writer, "431 Request Header Fields Too Large")
                return
            first_line = raw_head.split(b"\r\n", 1)[0].decode("latin-1", errors="replace").strip()
            parts = first_line.split()
            if len(parts) < 2:
                await _send_http(writer, "400 Bad Request")
                return
            method, target = parts[0].upper(), parts[1]

            if method == "GET" and target == "/health":
                await _send_http(writer, "200 OK", b"ok")
                return

            if method != "CONNECT":
                log.warning("EGRESS_DENY peer=%s method=%s target=%s reason=method_not_allowed", peer_ip, method, target)
                await _send_http(writer, "403 Forbidden", b"only HTTPS CONNECT is permitted\n")
                return

            if ":" not in target or target.startswith("["):
                log.warning("EGRESS_DENY peer=%s target=%s reason=invalid_authority", peer_ip, target)
                await _send_http(writer, "400 Bad Request", b"invalid CONNECT target\n")
                return
            host, port_s = target.rsplit(":", 1)
            try:
                port = int(port_s)
            except ValueError:
                await _send_http(writer, "400 Bad Request", b"invalid port\n")
                return

            if port not in self.allowed_ports:
                log.warning("EGRESS_DENY peer=%s host=%s port=%d reason=port_blocked", peer_ip, host, port)
                await _send_http(writer, "403 Forbidden", b"egress port blocked\n")
                return

            if not host_allowed(host, self.allowlist):
                log.warning("EGRESS_DENY peer=%s host=%s port=%d reason=host_not_allowlisted", peer_ip, host, port)
                await _send_http(writer, "403 Forbidden", b"egress host not in allowlist\n")
                return

            try:
                resolved_ip, resolved_port = await resolve_public_ip(
                    host, port, allow_non_public=self.allow_non_public,
                )
            except Exception as exc:
                log.warning("EGRESS_DENY peer=%s host=%s port=%d reason=%s", peer_ip, host, port, exc)
                await _send_http(writer, "403 Forbidden", b"egress target ip blocked\n")
                return

            try:
                remote_reader, remote_writer = await asyncio.wait_for(
                    asyncio.open_connection(resolved_ip, resolved_port),
                    timeout=_CONNECT_TIMEOUT_SEC,
                )
            except Exception as exc:
                log.warning("EGRESS_ERROR peer=%s host=%s ip=%s err=%s", peer_ip, host, resolved_ip, exc)
                await _send_http(writer, "502 Bad Gateway", b"upstream connect failed\n")
                return

            log.info("EGRESS_ALLOW peer=%s host=%s port=%d ip=%s", peer_ip, host, port, resolved_ip)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()

            t1 = asyncio.create_task(_relay(reader, remote_writer))
            t2 = asyncio.create_task(_relay(remote_reader, writer))
            await asyncio.gather(t1, t2, return_exceptions=True)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError, OSError):
            pass
        finally:
            for w in (remote_writer, writer):
                if w is not None:
                    try:
                        w.close()
                        await w.wait_closed()
                    except (OSError, RuntimeError):
                        pass


async def serve(host: str = "0.0.0.0", port: int = 3128) -> None:
    allowlist = parse_allowlist(os.getenv("TINA_EGRESS_ALLOWLIST"))
    proxy = EgressAllowlistProxy(allowlist=allowlist)
    server = await asyncio.start_server(proxy.handle_client, host=host, port=port, backlog=128)
    log.info("egress_proxy listening on %s:%d allowlist_entries=%d", host, port, len(allowlist))
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass
    async with server:
        await stop_event.wait()


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    port = int(os.getenv("TINA_EGRESS_PROXY_PORT", "3128"))
    asyncio.run(serve(port=port))


if __name__ == "__main__":
    main()
