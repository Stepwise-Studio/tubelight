"""Generative UI in chat (OpenUI Lang, openui.com): teammates may put a ```openui block in a reply and the app draws it
with native components. The instructions in genui.md are generated from the app's component list
(app/src/components/genui/spec.ts, `npm run genui-prompt`); never edit genui.md by hand."""
import re
from pathlib import Path

PROMPT = (Path(__file__).with_name("genui.md")).read_text()

_BLOCK = re.compile(r"```openui(?:-lang)?\s*\n(.*?)(?:```|$)", re.S)
_TITLE = re.compile(r'root\s*=\s*Card\(\s*"((?:[^"\\]|\\.)*)"')


def plain(text: str) -> str:
    """The reply with each drawing replaced by its title, for places that can't draw (notifications)."""
    def title(m: re.Match) -> str:
        t = _TITLE.search(m.group(1))
        return f"📊 {t.group(1)}" if t and t.group(1) else "📊 Chart"
    return _BLOCK.sub(title, text).strip()
