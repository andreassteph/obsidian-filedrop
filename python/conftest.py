"""Stub the heavy runtime deps so tests need only pytest installed."""

import sys
from unittest.mock import MagicMock

sys.modules.setdefault("markitdown", MagicMock())
sys.modules.setdefault("openai", MagicMock())
