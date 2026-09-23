"""Test setup: an isolated data folder per session.

Model-dependent tests use the models in MEETNOTE_MODELS (or the app's
default models folder) and are skipped when they are not installed.
Run `python -m meetnote --download-models` once to enable them.
"""
import os
import tempfile
from pathlib import Path

_home = tempfile.mkdtemp(prefix="meetnote-test-")
os.environ["MEETNOTE_HOME"] = _home

import pytest  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def models_ready() -> bool:
    from meetnote import models
    return all(models.installed(k) for k, m in models.REGISTRY.items() if m["required"])


needs_models = pytest.mark.skipif(not models_ready(), reason="speech models not installed")


@pytest.fixture(scope="session")
def home():
    return Path(_home)
