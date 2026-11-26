# AWS S3-Backed Ephemeral Workspaces & Sandbox Hardening

This document covers the AWS staging architecture for S3-backed ephemeral agent workspaces, multi-layer Fargate sandbox hardening, full-stack CloudWatch observability, and staging cost management.

## Architecture Overview

- **Storage (`deploy/aws/staging-workspace-s3.yml`):** Replaces per-user EFS access points with a single encrypted S3 bucket (`SSE-KMS` using `WorkspaceDataKey`, Versioning, TLS-only bucket policy, 30-day noncurrent version expiration) accessed through the S3 VPC Gateway Endpoint (`vpce-*` / `pl-63a5400a`).
- **KMS Isolation:** `WorkspaceDataKey` encrypts workspace snapshots and manifests; `WorkspaceSecretsKey` is restricted strictly to `agent-api` for per-user reusable GitHub credentials (`secrets/*`).
- **Ephemeral Fargate Worker (`tina-staging-ws-ephemeral`, `tina-staging-ws-nova`):**
  - Single static ARM64 Fargate task definition serving unlimited users and Shared Wikis via local ephemeral SSD (`/workspaces`).
  - Sidecar `sync` receives short-lived STS credentials scoped by an inline session policy (explicit `Deny` on `secrets/*` and `s3:DeleteObject*`), hydrates snapshots on startup, strips cache bloat (`.npm`, `.cache`, `node_modules`, `__pycache__`) during `_system` tar packaging, and commits Shared Wiki updates with optimistic concurrency (`If-Match` / HTTP `412` CAS + 3-way merge).
  - Container `worker` runs as non-root `1000:1000` with `ReadonlyRootFilesystem: true`, zero S3/SecretsManager IAM permissions (Bedrock-only `TaskRole`), and an isolated `worker-tmp` volume (`/tmp`) separated from `sync-tmp`.
- **Zero-Direct-Internet Egress Lockdown:**
  - `EphemeralWorkspaceSecurityGroup` removes `tcp/443 -> 0.0.0.0/0` completely.
  - Fargate execution traffic uses private VPC Interface Endpoints (`ecr.api`, `ecr.dkr`, `logs`, `secretsmanager`) and the S3 Gateway Endpoint.
  - Worker HTTPS egress routes exclusively through a dedicated zero-IAM Fargate proxy (`egress-proxy.tina-staging.local:3128`, `runtime_kernel.egress_proxy`) enforcing port-443 `CONNECT`, a domain allowlist, public-IP anti-SSRF / anti-DNS-rebinding verification, and `EGRESS_ALLOW`/`EGRESS_DENY` audit logs.
- **Runtime Quotas & Idle Reaper (`deploy/aws/staging-runtime.yml`):**
  - Enforces per-owner concurrency (`RUNTIME_OWNER_QUOTA=3`), deployment-wide cap (`RUNTIME_GLOBAL_QUOTA=20`), and a background `Enforcer` loop (`RUNTIME_REAPER_TICK_SEC=30`, `RUNTIME_WORKSPACE_IDLE_TIMEOUT_SEC=300`, `RUNTIME_WORKSPACE_MAX_LIFETIME_SEC=3600`).
- **Observability (`deploy/aws/staging-workspace-s3-monitoring.yml`):**
  - 20 CloudWatch Alarms covering S3 sync/CAS errors, Worker OOM/crash, Egress `EGRESS_DENY` spikes, Agent API 5xx/S3 errors, Runtime spawn failures, ALB 5xx/unhealthy targets, ECS memory pressure & crashes (`agent-api`, `core`, `viegem`, `voice`), and RDS CPU/storage/connections, routed to SNS `AlarmTopicArn` alongside the `tina-staging-s3-workspaces` Dashboard.
- **Custom Domain Cutover Ready (`deploy/aws/staging-domain-acm.yml`, `deploy/aws/staging-edge.yml`, `deploy/aws/staging-core.yml`):**
  - Optional `CustomDomainName`, `AcmCertificateArn`, `HostedZoneId`, and `GatewayExtensionOrigins` parameters allow zero-downtime cutover when a public domain or Chrome Extension ID is assigned.
- **Cost Control (`deploy/aws/staging-power.sh`):**
  - Supports `status`, `sleep-heavy` (scales heavy VieGem + Voice speech workers to 0), `sleep` (scales all 11 services to 0 and stops RDS), `wake`, and `wake-lite`.
