"""PyInstaller runtime hook that initializes MAW's stdio as UTF-8."""

from maw.console import configure_utf8_stdio


configure_utf8_stdio()
