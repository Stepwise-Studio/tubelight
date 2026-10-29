"""Site and app know-how for computer use: how a page or app is laid out and where its parts are, so the worker
loop (computer_use.subtask) doesn't have to discover LinkedIn's composer by trial and error.

These are Tubelight's own, the same for everyone. How the user wants something done ("my LinkedIn posts: a hook,
three lines, no hashtags") is a playbook (playbooks.py), taught in chat; the worker gets both.
"""

WEB = """Web pages: TYPE into a field types it for real, like a keyboard. After typing a search, KEYS ["enter"].
A button that can't be clicked: it's pressed with focus + Enter automatically. A page still loading: look again
before deciding. Ignore the browser's own address bar (combo box “Search...”) unless the goal is to go to a site."""

GUIDES: list[tuple[tuple[str, ...], str]] = [
    (("linkedin",), """LinkedIn on the web:
- A new post: on the feed, CLICK the button “Start a post”. A dialog opens with a text box (named like “Text editor
  for creating content”). CLICK or FOCUS it, then TYPE the whole post in one go.
- A draft means: the text is in that box and nothing more. DONE once the box shows the text; never press “Post”.
  To publish: CLICK “Post” (you're stopped right there until the user says yes).
- Kept for later ("save it as a draft"): CLICK “Dismiss” (the dialog's ×), then “Save as draft” in the question.
- A photo or file: “Add media” opens a file picker, which is outside the page: BLOCKED, say they pick the file."""),
    (("x.com", "twitter", "on x", " x "), """X (Twitter) on the web:
- A new post: on Home, the box at the top (named like “Post text”) takes it: CLICK or FOCUS it, then TYPE. Or go to
  x.com/compose/post, which opens the same box in a dialog.
- A draft means the text is in the box: DONE then; never press “Post”. To publish: CLICK “Post” (you're stopped
  right there until the user says yes).
- Over the length limit the counter turns red: BLOCKED and say how much too long, never cut it yourself.
- Kept for later: close the dialog (“Close”), then “Save” in the question (X keeps drafts under Drafts)."""),
    (("instagram",), """Instagram on the web:
- A post needs a photo or video: “New post” / “Create” (the + in the side bar) → “Select from computer” opens a file
  picker outside the page: BLOCKED, say they pick the file; then the caption box takes the text (TYPE)."""),
    (("notion",), """Notion on the web: a page's title is the first text box; the body takes text where the cursor is
(CLICK the empty line “Type '/' for commands”, then TYPE). “/” opens the block menu. Changes save by themselves."""),
]


def guide(*hints: str) -> str:
    """The know-how for whatever the hints (the app, its window title, the goal) mention, plus the web basics when
    it's a browser."""
    text = f" {' '.join(hints).lower()} "
    out = [g for keys, g in GUIDES if any(k in text for k in keys)]
    if out or any(b in text for b in ("zen", "firefox", "chrome", "chromium", "brave", "browser", "http", ".com")):
        out.insert(0, WEB)
    return "\n\n".join(out)
