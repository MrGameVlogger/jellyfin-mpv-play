"""First-run setup wizard window.
Port of macapp/Sources/SetupWindowController.swift for Linux/GTK.
"""
import os
import threading

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, Gdk, GdkPixbuf

from config_parser import (
    default_mpv_path,
    build_config,
    encrypt_value,
    get_fernet,
    test_connection,
    escape_config_value,
)


class SetupWizardWindow(Gtk.Window):
    TOTAL_STEPS = 5

    def __init__(self, config_dir, on_complete=None):
        super().__init__(title="Jellyfin MPV Play Setup")
        self.config_dir = config_dir
        self.on_complete = on_complete
        self.did_complete = False
        self.current_step = 0

        # Persisted values so back-navigation does not lose input.
        self._server = ""
        self._username = ""
        self._password = ""
        self._mpv_path = default_mpv_path()
        self._device_name = "Jellyfin MPV Play"
        self._device_id = ""

        # Live widgets for the current step (None when not on that step).
        self.server_field = None
        self.username_field = None
        self.password_field = None
        self.mpv_path_field = None
        self.device_name_field = None
        self.device_id_field = None
        self.test_button = None
        self.status_label = None

        self.set_default_size(520, 420)
        self.set_resizable(False)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.connect("delete-event", self._on_delete)

        self._init_css()
        self._build_layout()
        self._show_step(0)

    # -- Setup helpers -------------------------------------------------

    def _init_css(self):
        css = (
            b".entry-error { border: 2px solid #e53935; border-radius: 4px; }"
            b".tip-card { background-color: #e8f5e9; border-radius: 8px;"
            b" padding: 8px 10px; }"
        )
        provider = Gtk.CssProvider()
        provider.load_from_data(css)
        screen = Gdk.Screen.get_default()
        if screen is not None:
            Gtk.StyleContext.add_provider_for_screen(
                screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            )

    def _load_icon(self):
        icon_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "resources", "icon-light.svg",
        )
        if os.path.exists(icon_path):
            try:
                pb = GdkPixbuf.Pixbuf.new_from_file_at_size(icon_path, 64, 64)
                return Gtk.Image.new_from_pixbuf(pb)
            except Exception:
                pass
        return Gtk.Image.new_from_icon_name("help-about", Gtk.IconSize.DIALOG)

    def _build_layout(self):
        outer = Gtk.Box()
        outer.set_orientation(Gtk.Orientation.VERTICAL)
        outer.set_spacing(8)
        outer.set_margin_top(16)
        outer.set_margin_bottom(16)
        outer.set_margin_start(20)
        outer.set_margin_end(20)
        self.add(outer)

        # Header icon (decorative).
        icon_box = Gtk.Box()
        icon_box.set_orientation(Gtk.Orientation.HORIZONTAL)
        icon_box.set_halign(Gtk.Align.CENTER)
        icon_box.pack_start(self._load_icon(), False, False, 0)
        outer.pack_start(icon_box, False, False, 0)

        self.step_label = Gtk.Label()
        self.step_label.set_halign(Gtk.Align.CENTER)
        outer.pack_start(self.step_label, False, False, 0)

        self.title_label = Gtk.Label()
        self.title_label.set_halign(Gtk.Align.CENTER)
        self.title_label.set_line_wrap(True)
        outer.pack_start(self.title_label, False, False, 4)

        self.subtitle_label = Gtk.Label()
        self.subtitle_label.set_halign(Gtk.Align.CENTER)
        self.subtitle_label.set_line_wrap(True)
        outer.pack_start(self.subtitle_label, False, False, 0)

        # Middle container whose content is swapped per step.
        self.step_box = Gtk.Box()
        self.step_box.set_orientation(Gtk.Orientation.VERTICAL)
        self.step_box.set_spacing(10)
        outer.pack_start(self.step_box, True, True, 12)

        # Bottom button row: Skip (left), Back (center), Continue (right).
        btn_row = Gtk.Box()
        btn_row.set_orientation(Gtk.Orientation.HORIZONTAL)
        btn_row.set_spacing(8)

        self.skip_btn = Gtk.Button(label="Skip Setup")
        self.skip_btn.connect("clicked", self._on_skip)
        btn_row.pack_start(self.skip_btn, False, False, 0)

        btn_row.pack_start(Gtk.Box(), True, True, 0)

        self.back_btn = Gtk.Button(label="Back")
        self.back_btn.connect("clicked", self._on_back)
        btn_row.pack_start(self.back_btn, False, False, 0)

        btn_row.pack_start(Gtk.Box(), True, True, 0)

        self.continue_btn = Gtk.Button()
        self.continue_btn.connect("clicked", self._on_continue)
        self.continue_btn.get_style_context().add_class(Gtk.STYLE_CLASS_SUGGESTED_ACTION)
        btn_row.pack_start(self.continue_btn, False, False, 0)

        outer.pack_start(btn_row, False, False, 0)

    # -- Markup helpers ------------------------------------------------

    @staticmethod
    def _esc(text):
        return GLib.markup_escape_text(text)

    def _title(self, text):
        return '<span size="x-large" weight="bold">%s</span>' % self._esc(text)

    def _subtitle(self, text):
        return '<span foreground="#666666">%s</span>' % self._esc(text)

    def _muted(self, text):
        return '<span foreground="#888888" size="small">%s</span>' % self._esc(text)

    # -- Step management -----------------------------------------------

    def _clear_container(self):
        for child in self.step_box.get_children():
            self.step_box.remove(child)

    def _capture_fields(self):
        # Only read from widgets still attached to the container. Detached
        # widgets from earlier steps may return stale/empty text and would
        # overwrite values already captured during those steps.
        if self.server_field is not None and self.server_field.get_parent() is not None:
            self._server = self.server_field.get_text()
        if self.username_field is not None and self.username_field.get_parent() is not None:
            self._username = self.username_field.get_text()
        if self.password_field is not None and self.password_field.get_parent() is not None:
            self._password = self.password_field.get_text()
        if self.mpv_path_field is not None and self.mpv_path_field.get_parent() is not None:
            self._mpv_path = self.mpv_path_field.get_text()
        if self.device_name_field is not None and self.device_name_field.get_parent() is not None:
            self._device_name = self.device_name_field.get_text()
        if self.device_id_field is not None and self.device_id_field.get_parent() is not None:
            self._device_id = self.device_id_field.get_text()

    def _show_step(self, step):
        self._capture_fields()
        self.current_step = step
        self._clear_container()

        self.step_label.set_markup(
            '<span foreground="#888888">Step %d of %d</span>'
            % (step + 1, self.TOTAL_STEPS)
        )

        builders = [
            self._step_welcome,
            self._step_server,
            self._step_credentials,
            self._step_mpv,
            self._step_finish,
        ]
        builders[step]()

        self.show_all()
        self.back_btn.set_visible(step != 0)
        labels = ["Get Started", "Continue", "Continue", "Continue", "Start"]
        self.continue_btn.set_label(labels[step])

    # -- Step content --------------------------------------------------

    def _step_welcome(self):
        self.title_label.set_markup(self._title("Jellyfin MPV Play"))
        self.subtitle_label.set_markup(
            self._subtitle("Let's get you set up in just a few steps")
        )

        features = [
            ("media-playback-start-symbolic", "Play from Jellyfin web UI"),
            ("media-skip-forward-symbolic", "Auto-play next episode"),
            ("document-open-recent-symbolic", "Resume where you left off"),
            ("open-menu-symbolic", "Menu bar controls"),
        ]
        for icon, text in features:
            row = Gtk.Box()
            row.set_orientation(Gtk.Orientation.HORIZONTAL)
            row.set_spacing(12)
            row.set_halign(Gtk.Align.CENTER)
            img = Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.LARGE_TOOLBAR)
            row.pack_start(img, False, False, 0)
            label = Gtk.Label(label=text)
            label.set_xalign(0)
            row.pack_start(label, False, False, 0)
            self.step_box.pack_start(row, False, False, 0)

    def _step_server(self):
        self.title_label.set_markup(self._title("Connect to Your Server"))
        self.subtitle_label.set_markup(self._subtitle("Enter your Jellyfin server URL"))

        form = Gtk.Box()
        form.set_orientation(Gtk.Orientation.VERTICAL)
        form.set_spacing(8)
        form.set_halign(Gtk.Align.CENTER)

        row = Gtk.Box()
        row.set_orientation(Gtk.Orientation.HORIZONTAL)
        row.set_spacing(8)
        lbl = Gtk.Label(label="Server URL:")
        lbl.set_xalign(1.0)
        lbl.set_width_chars(11)
        row.pack_start(lbl, False, False, 0)
        self.server_field = Gtk.Entry()
        self.server_field.set_placeholder_text("http://192.168.1.100:8096")
        self.server_field.set_text(self._server)
        self.server_field.connect("activate", self._on_continue)
        row.pack_start(self.server_field, True, True, 0)
        form.pack_start(row, False, False, 0)

        help_lbl = Gtk.Label()
        help_lbl.set_markup(
            self._muted("Include the port number. Example: http://192.168.1.100:8096")
        )
        help_lbl.set_xalign(0)
        help_lbl.set_line_wrap(True)
        form.pack_start(help_lbl, False, False, 0)

        self.step_box.pack_start(form, False, False, 0)
        self.server_field.grab_focus()

    def _step_credentials(self):
        self.title_label.set_markup(self._title("Sign In"))
        self.subtitle_label.set_markup(
            self._subtitle("Enter your Jellyfin username and password")
        )

        form = Gtk.Box()
        form.set_orientation(Gtk.Orientation.VERTICAL)
        form.set_spacing(8)
        form.set_halign(Gtk.Align.CENTER)

        user_row = Gtk.Box()
        user_row.set_orientation(Gtk.Orientation.HORIZONTAL)
        user_row.set_spacing(8)
        ulbl = Gtk.Label(label="Username:")
        ulbl.set_xalign(1.0)
        ulbl.set_width_chars(11)
        user_row.pack_start(ulbl, False, False, 0)
        self.username_field = Gtk.Entry()
        self.username_field.set_text(self._username)
        self.username_field.connect("activate", self._on_continue)
        user_row.pack_start(self.username_field, True, True, 0)
        form.pack_start(user_row, False, False, 0)

        pass_row = Gtk.Box()
        pass_row.set_orientation(Gtk.Orientation.HORIZONTAL)
        pass_row.set_spacing(8)
        plbl = Gtk.Label(label="Password:")
        plbl.set_xalign(1.0)
        plbl.set_width_chars(11)
        pass_row.pack_start(plbl, False, False, 0)
        self.password_field = Gtk.Entry()
        self.password_field.set_visibility(False)
        self.password_field.set_text(self._password)
        self.password_field.connect("activate", self._on_continue)
        pass_row.pack_start(self.password_field, True, True, 0)
        form.pack_start(pass_row, False, False, 0)

        test_row = Gtk.Box()
        test_row.set_orientation(Gtk.Orientation.HORIZONTAL)
        test_row.set_spacing(8)
        self.test_button = Gtk.Button(label="Test Connection")
        self.test_button.connect("clicked", self._on_test_connection)
        test_row.pack_start(self.test_button, False, False, 0)
        self.status_label = Gtk.Label()
        self.status_label.set_xalign(0)
        test_row.pack_start(self.status_label, True, True, 0)
        form.pack_start(test_row, False, False, 0)

        self.step_box.pack_start(form, False, False, 0)
        self.username_field.grab_focus()

    def _step_mpv(self):
        self.title_label.set_markup(self._title("Configure MPV"))
        self.subtitle_label.set_markup(self._subtitle("Set up your video player"))

        form = Gtk.Box()
        form.set_orientation(Gtk.Orientation.VERTICAL)
        form.set_spacing(8)
        form.set_halign(Gtk.Align.CENTER)

        path_row = Gtk.Box()
        path_row.set_orientation(Gtk.Orientation.HORIZONTAL)
        path_row.set_spacing(8)
        plbl = Gtk.Label(label="MPV Path:")
        plbl.set_xalign(1.0)
        plbl.set_width_chars(11)
        path_row.pack_start(plbl, False, False, 0)
        self.mpv_path_field = Gtk.Entry()
        self.mpv_path_field.set_text(self._mpv_path or default_mpv_path())
        path_row.pack_start(self.mpv_path_field, True, True, 0)
        choose_btn = Gtk.Button(label="Choose\u2026")
        choose_btn.connect("clicked", self._on_browse_mpv)
        path_row.pack_start(choose_btn, False, False, 0)
        form.pack_start(path_row, False, False, 0)

        name_row = Gtk.Box()
        name_row.set_orientation(Gtk.Orientation.HORIZONTAL)
        name_row.set_spacing(8)
        nlbl = Gtk.Label(label="Device Name:")
        nlbl.set_xalign(1.0)
        nlbl.set_width_chars(11)
        name_row.pack_start(nlbl, False, False, 0)
        self.device_name_field = Gtk.Entry()
        self.device_name_field.set_text(self._device_name)
        name_row.pack_start(self.device_name_field, True, True, 0)
        form.pack_start(name_row, False, False, 0)

        id_row = Gtk.Box()
        id_row.set_orientation(Gtk.Orientation.HORIZONTAL)
        id_row.set_spacing(8)
        ilbl = Gtk.Label(label="Device ID:")
        ilbl.set_xalign(1.0)
        ilbl.set_width_chars(11)
        id_row.pack_start(ilbl, False, False, 0)
        self.device_id_field = Gtk.Entry()
        self.device_id_field.set_placeholder_text("auto-generated")
        self.device_id_field.set_text(self._device_id)
        id_row.pack_start(self.device_id_field, True, True, 0)
        form.pack_start(id_row, False, False, 0)

        help_lbl = Gtk.Label()
        help_lbl.set_markup(
            self._muted(
                "Device name appears in Jellyfin's device list. "
                "Leave Device ID empty to auto-generate."
            )
        )
        help_lbl.set_xalign(0)
        help_lbl.set_line_wrap(True)
        form.pack_start(help_lbl, False, False, 0)

        self.step_box.pack_start(form, False, False, 0)

    def _step_finish(self):
        self.title_label.set_markup(self._title("Ready to start"))
        self.subtitle_label.set_markup(self._subtitle("Review and start playing"))

        tips = [
            "The app runs from your system tray",
            "Open Jellyfin in your browser and use 'Play on' to start watching",
            "Use Settings from the tray menu to update these later",
            "Check the Help menu for tips and troubleshooting",
        ]
        for tip in tips:
            card = Gtk.Box()
            card.set_orientation(Gtk.Orientation.HORIZONTAL)
            card.set_spacing(10)
            card.get_style_context().add_class("tip-card")
            img = Gtk.Image.new_from_icon_name("emblem-ok-symbolic", Gtk.IconSize.BUTTON)
            card.pack_start(img, False, False, 0)
            lbl = Gtk.Label()
            lbl.set_markup(
                '<span foreground="#2e7d32">%s</span>' % self._esc(tip)
            )
            lbl.set_xalign(0)
            lbl.set_line_wrap(True)
            card.pack_start(lbl, True, True, 0)
            self.step_box.pack_start(card, False, False, 0)

    # -- Navigation / actions ------------------------------------------

    def _on_continue(self, *_):
        step = self.current_step

        if step == 1:
            raw = self.server_field.get_text() if self.server_field else ""
            if not raw.strip():
                self._shake(self.server_field)
                return
            url = raw.strip().rstrip("/")
            if not url.startswith(("http://", "https://")):
                url = "http://" + url
            self.server_field.set_text(url)
            self._server = url
        elif step == 2:
            ok = True
            if not (self.username_field.get_text() if self.username_field else "").strip():
                self._shake(self.username_field)
                ok = False
            if not (self.password_field.get_text() if self.password_field else ""):
                self._shake(self.password_field)
                ok = False
            if not ok:
                return

        if step < self.TOTAL_STEPS - 1:
            self._show_step(step + 1)
        else:
            self.save_and_finish()

    def _on_back(self, *_):
        if self.current_step > 0:
            self._show_step(self.current_step - 1)

    def _on_skip(self, *_):
        # Close without saving. Deliberately do NOT fire on_complete: the config
        # would be missing/incomplete, so starting the shim would loop on auth
        # failures. Settings covers every wizard field and can start the shim.
        self.hide()

    def _on_browse_mpv(self, *_):
        dialog = Gtk.FileChooserDialog(
            title="Select MPV Binary",
            transient_for=self,
            action=Gtk.FileChooserAction.OPEN,
        )
        dialog.add_buttons(
            "_Cancel", Gtk.ResponseType.CANCEL,
            "_Open", Gtk.ResponseType.OK,
        )
        if self.mpv_path_field and self.mpv_path_field.get_text():
            start = os.path.dirname(self.mpv_path_field.get_text())
            if os.path.isdir(start):
                dialog.set_current_folder(start)
        response = dialog.run()
        if response == Gtk.ResponseType.OK:
            self.mpv_path_field.set_text(dialog.get_filename())
        dialog.destroy()

    def _on_test_connection(self, *_):
        server = self._server or (self.server_field.get_text() if self.server_field else "")
        user = self.username_field.get_text() if self.username_field else ""
        pw = self.password_field.get_text() if self.password_field else ""
        if not server or not user or not pw:
            self._set_status("Fill in all fields", "#f9a825")
            return

        self.test_button.set_sensitive(False)
        self._set_status("Testing...", "#666666")

        def worker():
            ok, msg = test_connection(server, user, pw, "setup-test", "Setup")
            GLib.idle_add(self._test_done, ok, msg)

        threading.Thread(target=worker, daemon=True).start()

    def _test_done(self, ok, msg):
        self.test_button.set_sensitive(True)
        self._set_status(msg, "#2e7d32" if ok else "#c62828")
        return False

    def _set_status(self, text, color):
        self.status_label.set_markup(
            '<span foreground="%s">%s</span>' % (color, self._esc(text))
        )

    # -- Validation feedback -------------------------------------------

    def _shake(self, entry):
        if entry is None:
            return
        ctx = entry.get_style_context()
        ctx.add_class("entry-error")
        entry.set_icon_from_icon_name(Gtk.EntryIconPosition.SECONDARY, "dialog-warning")
        GLib.timeout_add(900, self._clear_error, entry)

    def _clear_error(self, entry):
        entry.get_style_context().remove_class("entry-error")
        entry.set_icon_from_icon_name(Gtk.EntryIconPosition.SECONDARY, None)
        return False

    # -- Persistence ---------------------------------------------------

    def save_and_finish(self):
        # Values were captured by _show_step() during the last transition.
        # Don't call _capture_fields() here — the widgets were detached by
        # _clear_container() and reading them may return stale/empty values.
        managed_keys = {
            "serverUrl", "username", "password",
            "mpvPath", "deviceName", "deviceId",
        }
        e = escape_config_value
        lines = [
            "    serverUrl: '%s'," % e(self._server),
            "    username: '%s'," % e(self._username),
            "    password: 'enc:%s'," % get_fernet().encrypt(self._password.encode()).decode(),
            "    mpvPath: '%s'," % e(self._mpv_path),
            "    deviceName: '%s'," % e(self._device_name),
            "    deviceId: '%s'," % e(self._device_id),
        ]

        path = os.path.join(self.config_dir, "config.js")
        existing = ""
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    existing = f.read()
            except OSError:
                existing = ""

        config = build_config(managed_keys, lines, existing)

        try:
            os.makedirs(self.config_dir, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(config)
            os.chmod(path, 0o600)
        except OSError as exc:
            self._alert("Failed to save config", str(exc))
            return

        self.did_complete = True
        if self.on_complete:
            self.on_complete()
        self.hide()

    def _on_delete(self, *_):
        self.hide()
        return True

    def _alert(self, title, message):
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
