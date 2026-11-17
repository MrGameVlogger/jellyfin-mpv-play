"""Desktop notifications via libnotify.
Port of macapp/Sources/NotificationManager.swift for Linux/GTK.
"""
import os

try:
    import gi
    gi.require_version("Notify", "0.7")
    from gi.repository import Notify
    _HAS_NOTIFY = True
except (ImportError, ValueError):
    _HAS_NOTIFY = False

_available = False


def init():
    global _available
    if not _HAS_NOTIFY:
        return
    try:
        if Notify.init("Jellyfin MPV Play"):
            _available = True
    except Exception:
        _available = False


def show_notification(title, message):
    if not _available:
        return
    try:
        n = Notify.Notification.new(title, message, "dialog-information")
        n.set_timeout(5000)
        n.show()
    except Exception:
        pass
