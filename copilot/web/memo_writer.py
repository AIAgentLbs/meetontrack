"""Pre-call memo writer: decides which calendar meetings involve outside participants."""

from __future__ import annotations

from twenty_crm import PUBLIC_DOMAINS

# Calendar addresses of rooms and groups: never a participant.
NOT_PEOPLE = ("resource.calendar.google.com", "group.calendar.google.com")
GENERIC_SECOND_LABELS = {"co", "com", "org", "net", "gov", "ac"}


def _domain(email: object) -> str:
    return str(email or "").rpartition("@")[2].strip().lower()


def outside_attendees(attendees: list[dict]) -> list[dict]:
    """Attendees from outside the user's own domain (everyone else when the user's domain is public)."""
    own = next((_domain(a.get("email")) for a in attendees if a.get("self")), "")
    people = [a for a in attendees if not a.get("self") and not a.get("resource")
              and not _domain(a.get("email")).endswith(NOT_PEOPLE)]
    if not own or own in PUBLIC_DOMAINS:
        return people
    return [a for a in people if (d := _domain(a.get("email"))) != own and not d.endswith("." + own)]


def is_external(attendees: list[dict]) -> bool:
    return bool(outside_attendees(attendees))


def company_from(email: str) -> str:
    """The company label of an e-mail domain; empty for a public mailbox or no domain."""
    if "@" not in str(email or ""):
        return ""
    labels = _domain(email).split(".")
    if len(labels) < 2 or ".".join(labels) in PUBLIC_DOMAINS:
        return ""
    labels.pop()  # top-level domain
    # ponytail: no public-suffix list; misnames rare ccTLD forms
    if len(labels) > 1 and (len(labels[-1]) == 2 or labels[-1] in GENERIC_SECOND_LABELS):
        labels.pop()
    return labels[-1]
