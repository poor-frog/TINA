# TINA on AWS

This deployment follows the TINA-copy architecture. The existing local Compose installation continues to serve meetings and use its private S3 recording bucket during the migration. The AWS foundation owns its own network and registry resources.

## 1. Foundation

Deploy the two-AZ network, S3 gateway endpoint, ECS cluster, and private ECR repositories from the repository root.

```sh
aws --profile tina --region us-east-1 cloudformation deploy \
  --stack-name tina-foundation \
  --template-file deploy/aws/foundation.yml \
  --tags Project=TINA Stage=foundation \
  --no-fail-on-empty-changeset
```

Public subnets have a route to the internet gateway. The private app subnets have an S3 route. Add app egress in the workload phase so the browser can reach meeting providers. The data subnets have local VPC routing only. Point staging at the stack's private `StagingRecordingsBucket`. The Compose recording bucket is managed outside this stack.

## 2. Verify the container deployment path

Push a trusted TINA image into the appropriate private ECR repository and use its digest with [container-smoke.yml](container-smoke.yml). Pass the foundation VPC ID, ECR repository ARN, and the image's architecture. CloudFormation needs `CAPABILITY_IAM` to create the task execution role.

Run one Fargate task using a foundation public subnet and the smoke security group. Assign a public IP for the registry pull. The group allows outbound HTTPS and has no inbound rules. Success means the task exits with code zero and CloudWatch records `TINA_RUNTIME_HEALTH_OK`. Delete the smoke stack after the task stops.

The default probe uses the Runtime process backend and calls the ASGI health endpoint in-process. Set `Probe=chromium` with the bot image to check that Chromium can render a local document under Fargate. The second probe prints `TINA_CHROMIUM_OK`.

## 3. Staging data

[staging-data.yml](staging-data.yml) creates an empty PostgreSQL 17 database and a cluster-mode-disabled Valkey 8.0 instance. Set `VpcId` and `DataSubnetIds` from the foundation outputs. To provision PostgreSQL first, create the stack with `DeployValkey=false`, then update it with `DeployValkey=true`. The security groups allow database and cache connections from tasks bearing the staging application security group. The stack outputs endpoint hostnames and Secrets Manager ARNs.

Use TLS from application tasks and a scoped database user for runtime traffic. Use the RDS-managed master secret for setup and migrations. Staging enables one day of automated RDS backups and preserves an RDS snapshot on deletion or replacement. The staging instances are Single-AZ and accrue charges while provisioned.

## 4. Staging HTTPS edge

[staging-edge.yml](staging-edge.yml) creates an internal ALB, a CloudFront VPC origin, and an HTTPS hostname with the default CloudFront certificate. Set `VpcId` and `AppSubnetIds` from the foundation outputs, `CloudFrontOriginPrefixListId` to the AWS-managed origin-facing prefix list, and `WebAclArn` to the approved existing CloudFront Web ACL.

The stack returns `StageUrl`. Its `/edge-health` path returns `TINA_EDGE_READY`. The default listener action returns 503 until the Terminal stack's forwarding rule is installed. The ALB accrues charges while it is provisioned.

## 5. Deploy the application

1. Deploy [ecs-bot.yml](ecs-bot.yml) with the ARM64 bot image digest and the staging bucket. [staging-egress.yml](staging-egress.yml) gives the two private app subnets Internet egress via a single staging NAT. Use the foundation public subnet in the same AZ as the first app subnet and pass both app route table IDs. The NAT and public IPv4 address accrue charges while provisioned.
2. Test fresh database migrations, Valkey stream consumption, and restore before cutting over production data. Give meeting-api its own task role for the staging S3 bucket.
3. Deploy Terminal, Gateway, meeting-api, Runtime, and speech services in staging. Benchmark VieGem on Linux CPU before sizing Fargate or selecting GPU EC2. Validate LiveKit media separately from HTTP ingress.
4. Attach Terminal to the staging ALB, then verify sign-in, recording, playback, and two concurrent meetings end to end. Bring in Cognito, Bedrock, and SES with their own acceptance checks. Switch traffic only after a successful rehearsal and a verified rollback path.

Set `RUNTIME_BACKEND=ecs`, `BROWSER_IMAGE` to the bot image digest,
`RUNTIME_ECS_CLUSTER`, `RUNTIME_ECS_BOT_TASK_DEFINITION` to the pinned task ARN,
`RUNTIME_ECS_SUBNETS` and `RUNTIME_ECS_SECURITY_GROUPS` to comma-separated IDs,
and `RUNTIME_ECS_INVOCATION_BUCKET` to the staging bucket. The Runtime task role needs
permission to launch and pass the roles of the pinned bot task, discover and stop its
tasks, and read, write, and delete objects under `runtime-invocations/`. The bot execution
role reads that prefix at boot. The bucket expires invocation files after one day.

[staging-runtime.yml](staging-runtime.yml) deploys the private Runtime ECS service with
the task role and bot task definition exported by the bot stack. Pass the Runtime image
digest from ECR, the foundation subnet IDs, the data stack's Valkey hostname and secret
ARN, and the data stack's application security group. Attach the stack's
`RuntimeClientSecurityGroupId` only to trusted control-plane tasks that call
`http://runtime.tina-staging.local:8090`. Meeting bot tasks use the data stack's
security group for access to Valkey.

This backend handles meeting bots. Agent workspaces and mounted voice assets need their
own ECS deployment before enabling those workloads. Use new workload IDs for new bot
attempts, and preserve the 30-second ECS stop timeout when setting Runtime grace.

## 6. Private meeting control plane

[staging-core.yml](staging-core.yml) runs `admin-api`, `meeting-api`, and Gateway in one
private Fargate task for staging. Use the ARM64 image digests from the private
`tina-staging/admin-api`, `tina-staging/meeting-api`, and `tina-staging/gateway` ECR
repositories. Set `ServiceNamespaceId` to the Runtime stack's Cloud Map namespace ID.

The init container grants a dedicated role access to the staging database over verified
TLS. The admin service initializes the schema before meeting-api starts. ECS injects
passwords and service tokens from Secrets Manager. Meeting-api uses the task role for
the staging recording bucket. Trusted clients bearing the exported client security group
can access the private Gateway. Bot tasks can send callbacks to meeting-api.

Verify identity, transcripts, recording playback and stop on staging before connecting
Terminal to the ALB. Use the mock-bot image with a temporary bot task definition for this
check, then restore the real bot definition. Keep the CloudFront default route on its
staging response until Terminal is ready.

## 7. Meetings-only Terminal

[staging-terminal.yml](staging-terminal.yml) runs Terminal on a private Fargate task.
Build its ARM64 image with `NEXT_PUBLIC_TERMINAL_MODE=meetings` and publish by digest
to the staging Terminal ECR repository. Use the edge stack's `StageUrl`, listener,
and ALB security group, plus the core stack's client security group and secret ARNs.
The internal ALB forwards to Terminal. Terminal uses the private Gateway and identity
service over Cloud Map.

For Google sign-in, create a staging Web application client with this authorized URI:
`${StageUrl}/api/auth/callback/google`. Store its `client_id` and `client_secret` in one
Secrets Manager JSON secret and pass its ARN as `GoogleSecretArn`. Calendar linking
requires separate registration of the `/api/auth/callback/google-calendar` callback.

Verify that `/api/auth/me` and `/api/meetings` return 401 without a session. Sign in
through the public hostname, then verify both calls return 200 for that session.

## 8. VieGem ASR staging

Build the CPU base image using the existing VieGem Dockerfile, then add the pinned
model cache from the VieGem installer. Keep the resulting image in a private ECR
repository. The packaging build and the worker both verify the model files.

```sh
docker build --platform linux/arm64 --build-arg TORCH_VARIANT=cpu \
  -t tina/v012-viegem:staging-cpu-base -f deploy/transcription/viegem/Dockerfile .
docker build --platform linux/arm64 --build-context viegem_assets=deploy/transcription/models/viegem-fsmn \
  -t tina/v012-viegem:staging-cpu-models -f deploy/aws/viegem.Dockerfile deploy/aws
```

[staging-viegem.yml](staging-viegem.yml) uses 2 vCPUs and 8 GiB per private
Fargate task. Run the benchmark before setting `DesiredCount` above zero. Verify
unauthenticated audio is rejected, Vietnamese test audio returns a transcript,
and one- and two-request latency meet the capture workload.

Set `TranscriptionUrl` and `TranscriptionTokenArn` on the core stack using the
VieGem stack outputs. ECS injects the worker token into meeting-api. The model
card declares a non-commercial license for the VieGem checkpoint, so this
deployment is for non-commercial staging evaluation.

## 7. VieNeu and LiveKit on staging

[staging-voice.yml](staging-voice.yml) runs CPU VieNeu, LiveKit Server and LiveKit Agent
on one private ARM64 Fargate task (2 vCPU, 8 GiB). The private Cloud Map name
`voice.tina-staging.local` serves synthesis on TCP 8000, the agent on TCP 8080,
signaling on TCP 7880, and WebRTC on UDP 7882 with TCP 7881 as fallback.
LiveKit rooms are in memory. Replacing the task interrupts rooms.

Build the existing TTS image from `deploy/tts`. Use `vieneu.Dockerfile` with a
`vieneu_assets` build context containing the HF cache populated by
`deploy/tts/install_models.py`. The image verifies the pinned files offline.
Build the Agent with `deploy/livekit/Dockerfile` and mirror the pinned Compose
LiveKit Server image to ECR. Pass the ARM64 image digests to the voice stack.
For the Meet bot, `bot-voice.Dockerfile` layers the pinned Silero VAD and the
`livekit-tina-v1` wake models onto the existing bot image via `voice_assets`.
Roll the bot task definition and then update the Runtime reference.

Pass the voice stack outputs into the core parameters `TtsUrl`,
`TtsTokenArn`, `TtsProfileKeyArn`, and `LiveKitAgentUrl`. This enables speech
on new staging bots. Wake-word answers require the separate TINA Agent API
and its configured answer backend. Transcription continues through the
existing VieGem HTTP endpoint. Run `voice-smoke.py` from a separate task with
the Agent image, the staging app security group, the private voice URLs
and Secrets Manager injected credentials. It verifies authenticated VieNeu
synthesis and publishes that PCM over WebRTC to a second LiveKit participant.
The Agent image's `smoke.py` also tests the room answer path using a synthetic
meeting authority. Terminal preview and an admitted Meet bot exercise the
user-facing flows.

## 8. Transcript-only voice answers on staging

[staging-agent-api.yml](staging-agent-api.yml) runs Agent API inside the staging VPC.
Only the Core security group can reach TCP 8100. The service reads transcript
sources with the authenticated meeting owner. Private Secrets Manager values
supply internal authentication, dispatch signing, and Valkey access.

Build `tina/v012-agent-api:staging-voice` with the existing Agent API Dockerfile,
then build `voice-worker.Dockerfile` using the repository root as context. With
`EnableVoiceCompletion=true`, the task role permits only Amazon Nova Lite
in the stack region. The task runs the shared meeting-knowledge worker as
bounded local subprocesses so the 30-second retrieval budget does not include
Fargate startup. The worker checks the current voice-turn lease and receives
a restricted environment. It uses CompletionPort without workspace mounts or
a model-driven tool harness.

Set Core's `AgentApiUrl` and `VoicePilotRoom` to the private Agent API URL and
one test Meet code. New sessions for that room enable LiveKit and seed a
current-transcript-only policy. Clear `VoicePilotRoom` to disable wake-word
answers on newly spawned bots. Run `voice-completion-smoke.py` in a temporary
task based on the Agent API task definition to verify the AWS task role and
a synthetic Redis voice lease.

## 9. ChatGPT plan pilot

For a personal self-hosted trial, authorize plan usage in the Terminal's loopback
Sign in with ChatGPT flow. Import only the selected, consented owner's connection
into an encrypted Secrets Manager secret. Preserve the AWS host ID across imports.
After transfer, let the AWS host own refresh for that session. Use a separate
connection if the local host also needs to refresh tokens concurrently.

Set `ChatGPTVoiceOwner`, `ChatGPTVoiceRoom`, `ChatGPTVoiceSecretArn` and
`ChatGPTVoiceModel` on the Agent API stack. Set Core's `VoicePilotRoom` to match.
Bedrock is the default. The ChatGPT route checks the owner, room, active turn and
current-transcript-only source policy before calling Responses. It sends no tools,
uses streaming with `store: false`, and does not switch providers on quota errors.
To disconnect staging, clear `ChatGPTVoiceSecretArn` in the stack before emptying
the imported secret and disconnecting the agent in ChatGPT Settings.
`chatgpt-voice-smoke.py` exercises the task role, account profile and source
verification with a synthetic transcript.

## Agent Reach on staging

[staging-agent-reach.yml](staging-agent-reach.yml) runs the pinned Agent Reach
image from [deploy/agent-reach](../agent-reach/) as one private ARM64 Fargate task.
Pass its `AgentReachUrl` and `AgentReachClientSecurityGroupId` outputs to
[staging-agent-api.yml](staging-agent-api.yml). The worker uses an ephemeral
directory for upstream state and reaches public HTTPS endpoints through the
staging egress. Only authorized Agent API tasks can connect to its HTTP port.

A room owner's `allow_web_search` policy and the voice public-query check still
apply. The public voice worker gets a query without meeting transcript,
documents, or chat history. The ChatGPT plan pilot remains transcript-only.
Verify with a synthetic meeting and a public question before granting web
search in real rooms.

## Read-only MCP on staging

Deploy [staging-mcp.yml](staging-mcp.yml), then set Core's `McpUrl`,
`McpGatewayTargetGroupArn`, and `McpOriginSecurityGroupId` to the MCP and
staging edge outputs. The CloudFront `/mcp` path routes through the ALB to
Gateway. Gateway is the only network caller of the private MCP transport.
Clients use Streamable HTTP and a TINA API token with the `tx` scope as
`Authorization: Bearer <key>`.

The staging tool set is `list_meetings`, `search_transcripts`, and
`get_meeting_transcript`. Each call goes back through Gateway with the
resolved key and the meeting service enforces its existing visibility rules.
The MCP transport binds the session to Gateway's resolved identity. A client
should initialize a new MCP session after an MCP task replacement.

## Post-meeting draft pilot

Build the `agent`, `runtime` and `gateway` targets in
[post-meeting-draft.Dockerfile](post-meeting-draft.Dockerfile) using the current
staging images as bases. Publish ARM64 images to the
existing staging repositories and use image digests in CloudFormation.

1. Update [staging-agent-api.yml](staging-agent-api.yml) with the new API image
   and `EnableDurableWorkspace=true`. This mounts a retained, encrypted EFS
   file system at `/workspaces` via an IAM-authorized access point over TLS.
2. Update [staging-runtime.yml](staging-runtime.yml) with the Runtime image,
   the API image digest as `DraftWorkerImage`, and the staging Valkey security
   group as `DraftValkeySecurityGroupId`. Draft tasks run on demand without
   the EFS mount. Their role can invoke Bedrock Nova Lite.
3. Apply [staging-core.yml](staging-core.yml) with the new Gateway image and
   the existing `AgentApiUrl` so the private Gateway authenticates requests
   for the Agent API. Preserve
   existing CloudFormation parameters during the updates.

From the VPC, send an authenticated
`POST /agent/workspace/meeting-knowledge/{meeting_id}/ask` with `question`,
`draft_document_workspace` (the authorized workspace slug), and `documents`
(an array containing one Markdown path). The meeting must be complete. Agent
API resolves both sources under the authenticated identity and checks them
again before returning the cited draft. The worker receives bounded excerpts
in an encrypted S3 invocation object under the existing one-day expiration
rule. The response is returned to the caller for review.

### Terminal pilot

Set `DraftPilotUserIds` on the Agent API stack to a comma-separated list of
pilot owners and roll out the Terminal image built in meetings mode. The
meeting's Notes tab displays **Bản nháp sau họp** for eligible owners of
completed meetings. Pick an authorized Markdown document and create a draft.

Terminal sends the signed-in user's session key through the existing Gateway.
The request returns a job ID before inference starts. Agent API stores the
latest job per owner and meeting on EFS, and checks the meeting and document
again before serving cited results. A worker that loses its Agent API process
can be retried after the four-minute job lease expires.

## Workspace Agent pilot

Build the worker, agent and runtime targets in
[`workspace-pilot.Dockerfile`](workspace-pilot.Dockerfile) from the verified
staging base images. Pin each result to its ECR digest. Deploy
[`staging-workspace-worker.yml`](staging-workspace-worker.yml) per pilot
account, then supply the exact task definitions, roles and security groups
to Runtime. Each task mounts the account's private workspace and continuity
directory via separate EFS access points.

Set the same `WorkspacePilotUserIds` on Agent API and Terminal. Build Terminal
with `NEXT_PUBLIC_TERMINAL_MODE=workspace-pilot`. Leave `WorkspacePilotStage` at
`closed` until the live tests pass, then advance through `chat`, `wiki`, and `routines`. The full workbench at
`/terminal` checks the authenticated account against the list. Chat and
scheduled turns use the pilot's ChatGPT consent for `gpt-6-luna`.

The private task definitions support personal workspaces. Deploy a separate
worker stack per pilot subject and active shared workspace. Set
`SharedWorkspace` to the existing workspace ID and `SharedAccess` to the
subject's granted role. Register every additional worker role in Agent API's
workspace EFS policy, then register each task definition, role, and security
group in Runtime. A viewer's EFS access point grants only `ClientMount` and
the container mounts that workspace read-only. A turn runs only when its
requested mount set matches a pinned definition, including each mount's
read/write mode. Each active combination of private and shared workspaces
needs a matching task definition before the worker can mount it.

## Custom domain, ACM SSL, and Chrome Extension cutover

Replace the default `*.cloudfront.net` hostname once a domain is owned so Google OAuth
callbacks, MCP public origins, and Chrome Extension CORS stay fixed across rebuilds.

1. **Issue the `us-east-1` ACM certificate** with [`staging-domain-acm.yml`](staging-domain-acm.yml):
   - Route53-managed DNS: pass `DomainName=<host>`, `CreateHostedZone=true` + `RootDomainName=<apex>` (or `ExistingHostedZoneId=<zone-id>`). Copy `NameServers` to your registrar if creating a new zone.
   - External DNS (e.g. Cloudflare): leave `CreateHostedZone=false` and `ExistingHostedZoneId=""`, then create the ACM DNS validation CNAME printed in ACM Console.
2. **Attach the custom domain to CloudFront** by updating `tina-staging-edge` with [`staging-edge.yml`](staging-edge.yml):
   - Pass `CustomDomainName=<host>`, `AcmCertificateArn=<CertificateArn>`, and `HostedZoneId=<zone-id>` (for automatic Route53 `A`/`AAAA` Alias records; for external DNS leave `HostedZoneId=""` and point a CNAME/ALIAS at `CloudFrontDomainName`).
3. **Update public origins & Chrome Extension CORS** across the application stacks:
   - `tina-staging-terminal`: update `StageUrl=https://<host>` (updates `NEXTAUTH_URL` and `TERMINAL_URL`).
   - `tina-staging-mcp`: update `PublicOrigin=https://<host>` (updates `TINA_MCP_PUBLIC_ORIGIN`).
   - `tina-staging-core`: set `GatewayExtensionOrigins=chrome-extension://<extension-id>` (can be enabled before custom domain cutover).
4. **Update Google Cloud Console & verify**:
   - Add Authorized JavaScript origin `https://<host>` and Authorized redirect URIs `https://<host>/api/auth/callback/google` and `https://<host>/api/auth/callback/google-calendar`.
   - Verify `GET https://<host>/edge-health` returns `TINA_EDGE_READY`, `GET https://<host>/api/auth/me` returns `401` unauthenticated, and OAuth sign-in returns `200`.

## Staging power management (sleep / wake cost control)

Use [`staging-power.sh`](staging-power.sh) to scale staging Fargate services down when
idle and restore them before demos or evaluations:

```sh
./deploy/aws/staging-power.sh status       # show all 11 ECS services, active sandboxes, and RDS state
./deploy/aws/staging-power.sh sleep-heavy  # stop VieGem + Voice (4 vCPU / 16 GiB); keep web/chat/wiki live
./deploy/aws/staging-power.sh sleep        # scale all 11 services to 0 and stop RDS (~70-85% compute savings)
./deploy/aws/staging-power.sh wake         # start RDS + wake all 11 services and verify CloudFront health
./deploy/aws/staging-power.sh wake-lite    # start RDS + wake 9 web/agent services (leave VieGem/Voice at 0)
```
