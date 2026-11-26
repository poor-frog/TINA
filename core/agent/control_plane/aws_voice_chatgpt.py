"""One consented ChatGPT profile for the private staging voice pilot."""

import json
import os
from uuid import uuid4

from control_plane.openai_auth import ChatGPTAuthError, _SCOPES, refresh_profile


def workspace_connected(subject: str) -> bool:
    return bool(subject and subject == os.getenv("TINA_CHATGPT_WORKSPACE_OWNER")
                and os.getenv("TINA_CHATGPT_WORKSPACE_SECRET_ARN"))


def _secret_client():
    import boto3
    from botocore.config import Config

    return boto3.client("secretsmanager", config=Config(
        connect_timeout=2, read_timeout=3, retries={"total_max_attempts": 1},
    ))


def _read_profile(client, secret, owner, scope):
    version = client.get_secret_value(SecretId=secret, VersionStage="AWSCURRENT")
    profile = json.loads(version["SecretString"])
    if (not isinstance(profile, dict) or profile.get("tina_owner") != owner
            or (scope and profile.get("tina_scope") != scope)
            or not profile.get("client_id") or not profile.get("refresh_token")
            or not _SCOPES <= set(profile.get("scopes", []))):
        raise ChatGPTAuthError("Connect the ChatGPT plan for this staging account")
    return version, profile


def workspace_status(subject: str) -> dict:
    from botocore.exceptions import BotoCoreError, ClientError

    if not workspace_connected(subject):
        return {"available": False, "connected": False}
    try:
        _, profile = _read_profile(_secret_client(), os.environ["TINA_CHATGPT_WORKSPACE_SECRET_ARN"],
                                   subject, "workspace-agent")
    except (ChatGPTAuthError, TypeError, ValueError, KeyError):
        return {"available": True, "connected": False}
    except (BotoCoreError, ClientError) as exc:
        raise ChatGPTAuthError("Workspace ChatGPT status is temporarily unavailable") from exc
    return {"available": True, "connected": bool(profile.get("access_token"))}


def workspace_access_token(subject: str, redis_url: str) -> str:
    if not workspace_connected(subject):
        raise ChatGPTAuthError("Connect a ChatGPT plan for this workspace")
    return _access_token(redis_url, os.environ["TINA_CHATGPT_WORKSPACE_SECRET_ARN"], subject,
                         "tina:workspace-chatgpt:" + subject, scope="workspace-agent")


def access_token(redis_url: str) -> str:
    return _access_token(redis_url, os.environ["TINA_CHATGPT_VOICE_SECRET_ARN"],
                         os.environ["TINA_CHATGPT_VOICE_OWNER"], "tina:chatgpt-voice:connection")


def _access_token(redis_url: str, secret: str, owner: str, lock: str, *, scope=None) -> str:
    import redis
    from botocore.exceptions import BotoCoreError, ClientError

    connection = redis.Redis.from_url(redis_url, socket_timeout=2, socket_connect_timeout=2)
    try:
        with connection.lock(lock, timeout=35, blocking_timeout=2):
            client = _secret_client()
            current, profile = _read_profile(client, secret, owner, scope)
            if refresh_profile(profile):
                value = json.dumps(profile, separators=(",", ":"))
                if not scope:
                    client.put_secret_value(SecretId=secret, SecretString=value)
                else:
                    # A local reauthorization can rotate the secret during a refresh.
                    candidate = str(uuid4())
                    stage = "tina-" + candidate
                    client.put_secret_value(SecretId=secret, SecretString=value,
                                            ClientRequestToken=candidate, VersionStages=[stage])
                    try:
                        client.update_secret_version_stage(
                            SecretId=secret, VersionStage="AWSCURRENT",
                            MoveToVersionId=candidate, RemoveFromVersionId=current["VersionId"],
                        )
                    finally:
                        client.update_secret_version_stage(
                            SecretId=secret, VersionStage=stage, RemoveFromVersionId=candidate,
                        )
            return str(profile["access_token"])
    except (BotoCoreError, ClientError, redis.RedisError, TypeError, ValueError, KeyError) as exc:
        raise ChatGPTAuthError("The staging ChatGPT connection could not be read or refreshed") from exc
    finally:
        connection.close()
