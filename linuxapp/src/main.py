#!/usr/bin/env python3
"""Jellyfin MPV Play — Linux tray application.
Port of the macOS menubar app for Linux using GTK3 + AyatanaAppIndicator3.
"""
import sys
import signal

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

from config_parser import (
    app_support_dir,
    config_path,
    extract_value,
    selected_config_file_name,
)
from node_manager import NodeProcessManager
from tray import TrayController
from log_viewer import LogViewerWindow
import notifications


class App:
    def __init__(self):
        self.config_dir = app_support_dir()
        self.node_manager = NodeProcessManager()
        self.log_viewer = LogViewerWindow()
        self.tray = TrayController(self.node_manager, self.log_viewer, self.config_dir)

        # Wire callbacks
        self.node_manager.log_handler = self._on_log
        self.node_manager.status_handler = self.tray.update_status
        self.node_manager.notification_handler = lambda t, m: GLib.idle_add(notifications.show_notification, t, m)

        self.tray.on_show_preferences = self._show_preferences
        self.tray.on_show_about = self._show_about
        self.tray.on_show_help = self._show_help
        self.tray.on_quit = self._quit
        self.tray.on_restart = self._restart

        self._preferences = None
        self._about = None
        self._help = None

        notifications.init()

        # Setup gate
        if self._needs_setup():
            self._show_setup()
        else:
            self.node_manager.start()

    def _on_log(self, line):
        GLib.idle_add(self.log_viewer.append_log, line)

    def _needs_setup(self):
        try:
            with open(config_path(selected_config_file_name())) as f:
                text = f.read()
            return not (
                extract_value(text, "serverUrl")
                and extract_value(text, "username")
                and extract_value(text, "password")
            )
        except FileNotFoundError:
            return True

    def _show_setup(self):
        from setup_wizard import SetupWizardWindow
        wizard = SetupWizardWindow(self.config_dir, on_complete=self._on_setup_complete)
        wizard.show_all()

    def _on_setup_complete(self):
        self.node_manager.start()

    def _show_preferences(self):
        if self._preferences is None:
            from preferences import PreferencesWindow
            self._preferences = PreferencesWindow(
                self.config_dir,
                on_save=self._on_preferences_saved,
            )
        self._preferences.present()

    def _on_preferences_saved(self):
        # Restart the shim after saving settings
        self.node_manager.stop(lambda: self.node_manager.start())

    def _show_about(self):
        if self._about is None:
            from about import AboutWindow
            self._about = AboutWindow()
        self._about.present()

    def _show_help(self):
        if self._help is None:
            from help_window import HelpWindow
            self._help = HelpWindow()
        self._help.present()

    def _restart(self):
        self.node_manager.stop(lambda: self.node_manager.start())

    def _quit(self):
        def _done():
            GLib.idle_add(Gtk.main_quit)

        if self.node_manager.is_playing:
            dialog = Gtk.MessageDialog(
                transient_for=None,
                modal=True,
                message_type=Gtk.MessageType.QUESTION,
                buttons=Gtk.ButtonsType.YES_NO,
                text="Quit while MPV is still playing?",
            )
            dialog.format_secondary_text("Playback will stop and MPV will close.")
            response = dialog.run()
            dialog.destroy()
            if response != Gtk.ResponseType.YES:
                return

        self.node_manager.stop(completion=_done)
        # Safety net: force quit after 5s
        GLib.timeout_add(5000, lambda: Gtk.main_quit())


def main():
    # Handle SIGINT/SIGTERM gracefully
    def _signal_handler(sig, frame):
        Gtk.main_quit()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    app = App()
    Gtk.main()


if __name__ == "__main__":
    main()
