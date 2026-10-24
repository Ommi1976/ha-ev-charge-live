"""Global pytest fixtures and test environment configuration."""
import os
import shutil
import tempfile
import pytest

# Ensure all tests run with an isolated temporary data directory before any app module is loaded
_SESSION_TEST_DATA_DIR = tempfile.mkdtemp(prefix="ev-charge-live-pytest-")
os.environ["DATA_DIR"] = _SESSION_TEST_DATA_DIR


@pytest.fixture(scope="session", autouse=True)
def cleanup_test_data_dir():
    """Clean up the session temporary data directory on test completion."""
    yield
    try:
        shutil.rmtree(_SESSION_TEST_DATA_DIR, ignore_errors=True)
    except Exception:
        pass
