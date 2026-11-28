import pytest
from fastapi import HTTPException

from admin_api.app.main import MODEL_MODES, _apply_config_update, _validate_config_fields


def test_antigravity_mode_requires_a_persisted_terms_acknowledgment():
    assert "antigravity" in MODEL_MODES

    with pytest.raises(HTTPException) as error:
        _apply_config_update({}, {"mode": "antigravity"})
    assert error.value.status_code == 422

    configured = _apply_config_update({}, {
        "mode": "antigravity",
        "antigravity_terms_acknowledged": "true",
    })
    assert configured["mode"] == "antigravity"
    assert configured["antigravity_terms_acknowledged"] == "true"

    with pytest.raises(HTTPException):
        _apply_config_update(configured, {"antigravity_terms_acknowledged": ""})


def test_other_model_modes_do_not_require_antigravity_acknowledgment():
    assert _apply_config_update({}, {"mode": "subscription"}) == {"mode": "subscription"}


def test_meeting_use_default_validation_persistence_and_provider_switch_clear():
    saved = _apply_config_update({}, _validate_config_fields({
        "mode": "openai-api",
        "model": "gpt-5",
        "api_key": "sk-test-1234",
        "meeting_use_default": "true",
    }, kind="model_prefs"))
    assert saved["meeting_use_default"] == "true"

    # Explicit false and empty clear are both accepted
    toggled_off = _apply_config_update(saved, _validate_config_fields({"meeting_use_default": "false"}, kind="model_prefs"))
    assert toggled_off["meeting_use_default"] == "false"
    cleared = _apply_config_update(toggled_off, _validate_config_fields({"meeting_use_default": ""}, kind="model_prefs"))
    assert "meeting_use_default" not in cleared

    # Invalid boolean string is rejected with 422
    with pytest.raises(HTTPException) as err:
        _validate_config_fields({"meeting_use_default": "yes"}, kind="model_prefs")
    assert err.value.status_code == 422

    # Switching provider clears meeting_use_default along with old provider keys/models
    switched = _apply_config_update(saved, _validate_config_fields({"mode": "gemini"}, kind="model_prefs"))
    assert switched == {"mode": "gemini"}

