"""One consented ChatGPT profile for the private staging voice pilot."""

import json
import os

from control_plane.openai_auth import ChatGPTAuthError, _SCOPES, refresh_profile


def access_token(redis_url: str) -> str:
    import boto3
    import redis
    from botocore.config import Config
    from botocore.exceptions import BotoCoreError, ClientError

    secret = os.environ["TINA_CHATGPT_VOICE_SECRET_ARN"]
    connection = redis.Redis.from_url(redis_url, socket_timeout=2, socket_connect_timeout=2)
    try:
        with connection.lock("tina:chatgpt-voice:connection", timeout=35, blocking_timeout=2):
            client = boto3.client("secretsmanager", config=Config(
                connect_timeout=2, read_timeout=3, retries={"total_max_attempts": 1},
            ))
            profile = json.loads(client.get_secret_value(SecretId=secret)["SecretString"])
            if (not isinstance(profile, dict) or profile.get("tina_owner") != os.environ["TINA_CHATGPT_VOICE_OWNER"]
                    or not profile.get("client_id") or not profile.get("refresh_token")
                    or not _SCOPES <= set(profile.get("scopes", []))):
                raise ChatGPTAuthError("Connect the ChatGPT plan for this staging account")
            if refresh_profile(profile):
                client.put_secret_value(SecretId=secret, SecretString=json.dumps(profile, separators=(",", ":")))
            return str(profile["access_token"])
    except (BotoCoreError, ClientError, redis.RedisError, TypeError, ValueError, KeyError) as exc:
        raise ChatGPTAuthError("The staging ChatGPT connection could not be read or refreshed") from exc
    finally:
        connection.close()
