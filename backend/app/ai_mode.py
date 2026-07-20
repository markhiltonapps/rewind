import os


def ai_mode() -> str:
    return os.environ.get("REWIND_AI_MODE", "local").strip().lower()


def is_cloud() -> bool:
    return ai_mode() == "cloud"
