#!/usr/bin/env python3
"""Settings window for Jellyfin MPV Play.
Port of macapp/Sources/PreferencesWindowController.swift for Linux/GTK3.
"""
import os
import threading

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib, Pango

from config_parser import (
    build_config,
    config_path,
    default_ipc_socket_path,
    default_mpv_path,
    escape_config_value,
    extract_value,
    list_config_files,
    selected_config_file_name,
    set_selected_config_file_name,
    test_connection,
)

MANAGED_KEYS = {
    "serverUrl",
    "username",
    "password",
    "apiKey",
    "mpvPath",
    "deviceName",
    "deviceId",
    "ipcSocketPath",
    "mpvFlags",
    "fullscreen",
    "autoClose",
    "headless",
    "autoSkipIntros",
    "disableSkipIntro",
    "verbose",
}

STATUS_COLORS = {
    "green": "#2e7d32",
    "red": "#c62828",
    "yellow": "#b8860b",
}



def _rgba(spec):
    color = Gdk.RGBA()
    color.parse(spec)
    return color


class PreferencesWindow(Gtk.Window):
    """Settings form (hidden on close, reused across shows)."""

    def __init__(self, config_dir, on_save=None):
        super().__init__(title="Settings")
        self.config_dir = config_dir
        self.on_save = on_save
        self._populating = False

        self.set_default_size(560, 740)
        self.set_resizable(False)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.connect("delete-event", self._on_delete)
        self.connect("key-press-event", self._on_key_press)

        outer = Gtk.Box()
        outer.set_orientation(Gtk.Orientation.VERTICAL)
        self.add(outer)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)
        outer.pack_start(scrolled, True, True, 0)

        self.form_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.form_box.set_margin_top(14)
        self.form_box.set_margin_bottom(14)
        self.form_box.set_margin_start(16)
        self.form_box.set_margin_end(16)
        scrolled.add(self.form_box)

        self._build_config_section()
        self._add_separator()
        self._build_connection_section()
        self._add_separator()
        self._build_playback_section()
        self._add_separator()
        self._build_options_section()

        # Bottom buttons — Save is the default (Return), Cancel is Escape.
        button_row = Gtk.Box()
        button_row.set_orientation(Gtk.Orientation.HORIZONTAL)
        button_row.set_spacing(8)
        button_row.set_margin_top(8)
        button_row.set_margin_bottom(12)
        button_row.set_margin_start(16)
        button_row.set_margin_end(16)

        cancel_button = Gtk.Button(label="Cancel")
        cancel_button.connect("clicked", self._on_cancel)

        self.save_button = Gtk.Button(label="Save")
        self.save_button.set_can_default(True)
        self.save_button.get_style_context().add_class(Gtk.STYLE_CLASS_SUGGESTED_ACTION)
        self.save_button.connect("clicked", self._on_save_clicked)

        button_row.pack_end(self.save_button, False, False, 0)
        button_row.pack_end(cancel_button, False, False, 0)
        self.set_default(self.save_button)
        outer.pack_start(button_row, False, False, 0)

        self._populate_config_files()
        self.load_config()

    # ------------------------------------------------------------------ UI

    def _section_label(self, text):
        label = Gtk.Label(label=text)
        label.set_halign(Gtk.Align.START)
        attrs = Pango.AttrList()
        attrs.insert(Pango.AttrFontDesc.new(Pango.FontDescription.from_string("bold 13")))
        label.set_attributes(attrs)
        return label

    def _field_label(self, text):
        label = Gtk.Label(label=text, xalign=1.0)
        label.set_halign(Gtk.Align.END)
        label.set_size_request(112, -1)
        return label

    def _entry(self, placeholder=None, tooltip=None):
        entry = Gtk.Entry()
        entry.set_hexpand(True)
        entry.set_activates_default(True)
        if placeholder:
            entry.set_placeholder_text(placeholder)
        if tooltip:
            entry.set_tooltip_text(tooltip)
        return entry

    def _row(self, label_text, widgets):
        """Builds a form row. widgets: list of (widget, expand) tuples."""
        row = Gtk.Box()
        row.set_orientation(Gtk.Orientation.HORIZONTAL)
        row.set_spacing(8)
        row.pack_start(self._field_label(label_text), False, False, 0)
        for widget, expand in widgets:
            row.pack_start(widget, expand, expand, 0)
        self.form_box.pack_start(row, False, False, 0)
        return row

    def _add_separator(self):
        separator = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        separator.set_margin_top(4)
        separator.set_margin_bottom(4)
        self.form_box.pack_start(separator, False, False, 0)

    def _build_config_section(self):
        self.form_box.pack_start(self._section_label("Config File"), False, False, 0)

        self.config_combo = Gtk.ComboBoxText()
        self.config_combo.connect("changed", self._on_config_file_changed)

        refresh_button = Gtk.Button(label="Refresh")
        refresh_button.connect("clicked", self._on_refresh_clicked)

        self._row("Active config:", [(self.config_combo, True), (refresh_button, False)])

    def _build_connection_section(self):
        self.form_box.pack_start(self._section_label("Connection"), False, False, 0)

        self.server_url_entry = self._entry(placeholder="http://192.168.1.100:8096")
        self._row("Server URL:", [(self.server_url_entry, True)])

        self.username_entry = self._entry()
        self._row("Username:", [(self.username_entry, True)])

        self.password_entry = self._entry()
        self.password_entry.set_visibility(False)
        self.password_toggle = Gtk.Button(label="Show")
        self.password_toggle.connect("clicked", self._on_toggle_password)
        self._row("Password:", [(self.password_entry, True), (self.password_toggle, False)])

        self.api_key_entry = self._entry(
            placeholder="Leave empty to use your login token",
            tooltip=(
                "Optional. Jellyfin Dashboard \u2192 API Keys. Media URLs in the MPV "
                "playlist use this instead of your login token, so a mid-session "
                "password change or token revocation can't kill the rest of the "
                "queue. Leave empty to use the login token."
            ),
        )
        self.api_key_entry.set_visibility(False)
        self._row("API Key:", [(self.api_key_entry, True)])

        self.test_button = Gtk.Button(label="Test Connection")
        self.test_button.connect("clicked", self._on_test_connection)

        self.status_label = Gtk.Label(label="")
        self.status_label.set_halign(Gtk.Align.START)
        self.status_label.set_ellipsize(Pango.EllipsizeMode.END)
        attrs = Pango.AttrList()
        attrs.insert(Pango.AttrFontDesc.new(Pango.FontDescription.from_string("12")))
        self.status_label.set_attributes(attrs)

        row = Gtk.Box()
        row.set_orientation(Gtk.Orientation.HORIZONTAL)
        row.set_spacing(12)
        row.pack_start(self._field_label(""), False, False, 0)
        row.pack_start(self.test_button, False, False, 0)
        row.pack_start(self.status_label, True, True, 0)
        self.form_box.pack_start(row, False, False, 0)

    def _build_playback_section(self):
        self.form_box.pack_start(self._section_label("Playback"), False, False, 0)

        self.mpv_path_entry = self._entry(
            tooltip="Full path to the mpv binary (e.g. /usr/bin/mpv)"
        )
        choose_button = Gtk.Button(label="Choose\u2026")
        choose_button.connect("clicked", self._on_choose_mpv)
        self._row("MPV Path:", [(self.mpv_path_entry, True), (choose_button, False)])

        self.device_name_entry = self._entry()
        self._row("Device Name:", [(self.device_name_entry, True)])

        self.device_id_entry = self._entry(
            placeholder="auto-generated",
            tooltip="Leave empty to auto-generate a unique ID per config",
        )
        self._row("Device ID:", [(self.device_id_entry, True)])

        self.ipc_socket_entry = self._entry(
            placeholder=default_ipc_socket_path(),
            tooltip="MPV control socket path (max 100 characters)",
        )
        self._row("IPC Socket:", [(self.ipc_socket_entry, True)])

        self.mpv_flags_entry = self._entry(
            placeholder="--hwdec=auto, --vo=gpu-next",
            tooltip="Comma-separated extra mpv arguments (e.g. --hwdec=auto, --vo=gpu-next)",
        )
        self._row("MPV Flags:", [(self.mpv_flags_entry, True)])

    def _build_options_section(self):
        self.form_box.pack_start(self._section_label("Options"), False, False, 0)

        columns = Gtk.Box()
        columns.set_orientation(Gtk.Orientation.HORIZONTAL)
        columns.set_spacing(24)
        left = Gtk.Box()
        left.set_orientation(Gtk.Orientation.VERTICAL)
        left.set_spacing(6)
        right = Gtk.Box()
        right.set_orientation(Gtk.Orientation.VERTICAL)
        right.set_spacing(6)
        columns.pack_start(left, True, True, 0)
        columns.pack_start(right, True, True, 0)
        self.form_box.pack_start(columns, False, False, 0)

        self.fullscreen_check = Gtk.CheckButton(label="Start in fullscreen")
        left.pack_start(self.fullscreen_check, False, False, 0)

        self.headless_check = Gtk.CheckButton(label="Headless mode")
        left.pack_start(self.headless_check, False, False, 0)

        skip_label = Gtk.Label(label="Intro skipping:", xalign=0.0)
        skip_label.set_halign(Gtk.Align.START)
        skip_label.set_margin_top(6)
        left.pack_start(skip_label, False, False, 0)

        radios = Gtk.Box()
        radios.set_orientation(Gtk.Orientation.HORIZONTAL)
        radios.set_spacing(12)
        radios.set_margin_start(2)
        self.skip_auto_radio = Gtk.RadioButton.new_with_label(None, "Auto-skip")
        self.skip_prompt_radio = Gtk.RadioButton.new_with_label_from_widget(
            self.skip_auto_radio, "Show prompt"
        )
        self.skip_off_radio = Gtk.RadioButton.new_with_label_from_widget(
            self.skip_auto_radio, "Off"
        )
        radios.pack_start(self.skip_auto_radio, False, False, 0)
        radios.pack_start(self.skip_prompt_radio, False, False, 0)
        radios.pack_start(self.skip_off_radio, False, False, 0)
        left.pack_start(radios, False, False, 0)

        self.auto_close_check = Gtk.CheckButton(label="Close when playback ends")
        right.pack_start(self.auto_close_check, False, False, 0)

        self.verbose_check = Gtk.CheckButton(label="Verbose logging")
        right.pack_start(self.verbose_check, False, False, 0)

    # ------------------------------------------------------------- Actions

    def present(self):
        # Reload on every show so Cancel is a true cancel: edits and config
        # selection changes made since the last save are discarded.
        self._populate_config_files()
        self.load_config()
        self.show_all()
        super().present()
        self.server_url_entry.grab_focus()

    def _on_delete(self, *_args):
        self.hide()
        return True

    def _on_key_press(self, _widget, event):
        if event.keyval == Gdk.KEY_Escape:
            self.hide()
            return True
        return False

    def _on_cancel(self, _button):
        self.hide()

    def _on_save_clicked(self, _button):
        self.save_config()

    def _on_config_file_changed(self, combo):
        if self._populating:
            return
        name = combo.get_active_text()
        if not name:
            return
        set_selected_config_file_name(name)
        self.load_config()

    def _on_refresh_clicked(self, _button):
        self._populate_config_files()
        self.load_config()

    def _on_toggle_password(self, _button):
        visible = not self.password_entry.get_visibility()
        self.password_entry.set_visibility(visible)
        self.password_toggle.set_label("Hide" if visible else "Show")

    def _on_choose_mpv(self, _button):
        dialog = Gtk.FileChooserDialog(
            title="Select MPV Binary",
            transient_for=self,
            action=Gtk.FileChooserAction.OPEN,
        )
        dialog.add_buttons(
            "_Cancel", Gtk.ResponseType.CANCEL,
            "_Open", Gtk.ResponseType.OK,
        )
        current = self.mpv_path_entry.get_text().strip()
        if current:
            folder = os.path.dirname(current)
            if os.path.isdir(folder):
                dialog.set_current_folder(folder)
        try:
            if dialog.run() == Gtk.ResponseType.OK:
                self.mpv_path_entry.set_text(dialog.get_filename())
        finally:
            dialog.destroy()

    def _on_test_connection(self, _button):
        server_url = self.server_url_entry.get_text().strip()
        username = self.username_entry.get_text().strip()
        password = self.password_entry.get_text()
        if not server_url or not username or not password:
            self._set_status("Fill in all fields first", "yellow")
            return

        self.test_button.set_sensitive(False)
        self._set_status("Testing...", None)

        device_id = self.device_id_entry.get_text().strip() or "test-device"
        device_name = self.device_name_entry.get_text().strip() or "Jellyfin MPV Play"

        def worker():
            success, message = test_connection(
                server_url, username, password, device_id, device_name
            )
            GLib.idle_add(self._finish_test, success, message)

        threading.Thread(target=worker, daemon=True).start()

    def _finish_test(self, success, message):
        self.test_button.set_sensitive(True)
        self._set_status(message, "green" if success else "red")
        return False

    def _set_status(self, text, color_key):
        self.status_label.set_text(text)
        if color_key:
            self.status_label.override_color(
                Gtk.StateFlags.NORMAL, _rgba(STATUS_COLORS[color_key])
            )
        else:
            self.status_label.override_color(Gtk.StateFlags.NORMAL, None)

    def _show_error_dialog(self, message, title="Missing required fields"):
        dialog = Gtk.MessageDialog(
            transient_for=self,
            modal=True,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.OK,
            text=title,
        )
        dialog.format_secondary_text(message)
        dialog.run()
        dialog.destroy()

    # ------------------------------------------------------------ Config IO

    def _populate_config_files(self):
        self._populating = True
        try:
            self.config_combo.remove_all()
            files = list_config_files()
            for name in files:
                self.config_combo.append_text(name)
            selected = selected_config_file_name()
            if selected in files:
                self.config_combo.set_active(files.index(selected))
            elif files:
                self.config_combo.set_active(0)
                set_selected_config_file_name(files[0])
        finally:
            self._populating = False

    def load_config(self):
        try:
            with open(config_path(selected_config_file_name()), "r", encoding="utf-8") as f:
                content = f.read()
        except OSError:
            content = ""

        self.server_url_entry.set_text(extract_value(content, "serverUrl"))
        self.username_entry.set_text(extract_value(content, "username"))
        self.password_entry.set_text(extract_value(content, "password"))
        # Optional: empty means the shim falls back to the login token.
        self.api_key_entry.set_text(extract_value(content, "apiKey"))

        mpv_path = extract_value(content, "mpvPath") or default_mpv_path()
        self.mpv_path_entry.set_text(mpv_path)

        device_name = extract_value(content, "deviceName") or "Jellyfin MPV Play"
        self.device_name_entry.set_text(device_name)

        # Empty deviceId is valid: shim.js then generates a unique per-config id.
        self.device_id_entry.set_text(extract_value(content, "deviceId"))

        ipc_path = extract_value(content, "ipcSocketPath") or default_ipc_socket_path()
        self.ipc_socket_entry.set_text(ipc_path)

        # extract_value joins array items with a literal `", "` (quote-comma-quote);
        # normalize back to plain comma separation so the field round-trips.
        self.mpv_flags_entry.set_text(extract_value(content, "mpvFlags").replace('", "', ", "))

        self.fullscreen_check.set_active(extract_value(content, "fullscreen") == "true")
        self.auto_close_check.set_active(extract_value(content, "autoClose") == "true")
        self.headless_check.set_active(extract_value(content, "headless") == "true")
        self.verbose_check.set_active(extract_value(content, "verbose") == "true")

        auto_skip = extract_value(content, "autoSkipIntros") == "true"
        skip_off = extract_value(content, "disableSkipIntro") == "true"
        self.skip_auto_radio.set_active(auto_skip and not skip_off)
        self.skip_off_radio.set_active(skip_off)
        self.skip_prompt_radio.set_active(not (auto_skip and not skip_off) and not skip_off)

        self.password_entry.set_visibility(False)
        self.password_toggle.set_label("Show")
        self._set_status("", None)

    @staticmethod
    def _js_bool(widget):
        return str(widget.get_active()).lower()

    @staticmethod
    def _parse_mpv_flags(text):
        # Split on commas first (flag values may contain spaces); fall back
        # to whitespace splitting when the user typed space-separated flags.
        text = text.strip()
        if not text:
            return []
        flags = [part.strip() for part in text.split(",") if part.strip()]
        if len(flags) <= 1:
            flags = text.split()
        return flags

    def save_config(self):
        server_url = self.server_url_entry.get_text().strip()
        username = self.username_entry.get_text().strip()
        password = self.password_entry.get_text()
        if not server_url or not username or not password:
            self._show_error_dialog("Server URL, Username, and Password are required.")
            return

        lines = [
            f"    serverUrl: '{escape_config_value(server_url)}',",
            f"    username: '{escape_config_value(username)}',",
            f"    password: '{escape_config_value(password)}',",
        ]

        # Optional — omitted when empty, so the shim falls back to the login token.
        api_key = self.api_key_entry.get_text().strip()
        if api_key:
            lines.append(f"    apiKey: '{escape_config_value(api_key)}',")

        lines.append(f"    mpvPath: '{escape_config_value(self.mpv_path_entry.get_text().strip())}',")
        lines.append(f"    deviceName: '{escape_config_value(self.device_name_entry.get_text().strip())}',")
        lines.append(f"    deviceId: '{escape_config_value(self.device_id_entry.get_text().strip())}',")

        ipc_path = self.ipc_socket_entry.get_text().strip()
        if ipc_path:
            lines.append(f"    ipcSocketPath: '{escape_config_value(ipc_path)}',")

        flags = self._parse_mpv_flags(self.mpv_flags_entry.get_text())
        rendered = ", ".join(f"'{escape_config_value(flag)}'" for flag in flags)
        lines.append(f"    mpvFlags: [{rendered}],")

        lines.append(f"    fullscreen: {self._js_bool(self.fullscreen_check)},")
        lines.append(f"    autoClose: {self._js_bool(self.auto_close_check)},")
        lines.append(f"    headless: {self._js_bool(self.headless_check)},")
        lines.append(f"    autoSkipIntros: {self._js_bool(self.skip_auto_radio)},")
        lines.append(f"    disableSkipIntro: {self._js_bool(self.skip_off_radio)},")
        lines.append(f"    verbose: {self._js_bool(self.verbose_check)},")

        # The panel owns all 15 keys. Everything else in the file (comments,
        # user-added keys) is preserved verbatim; apiKey and ipcSocketPath are
        # omitted entirely when empty so the shim falls back to its defaults.
        config_file_name = selected_config_file_name()
        path = config_path(config_file_name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                existing = f.read()
        except OSError:
            existing = None

        content = build_config(MANAGED_KEYS, lines, existing)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError as e:
            self._show_error_dialog(str(e), title="Failed to save config")
            return

        if self.on_save:
            self.on_save()
        self.hide()
