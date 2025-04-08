import re
import subprocess

from notebook.base.handlers import IPythonHandler
from notebook.utils import url_path_join


class UptimeHandler(IPythonHandler):
    def get(self):
        try:
            output = subprocess.check_output(["ps", "-p", "1", "-o", "etime="])
            uptime = output.decode("utf-8").strip()
            seconds = self._parse_uptime_to_seconds(uptime)
            self.finish({"uptime": seconds})
        except Exception as e:
            self.set_status(500)
            self.finish({"error": str(e)})

    @staticmethod
    def _parse_uptime_to_seconds(uptime: str) -> int:
        # Supports MM:SS, HH:MM:SS, or D-HH:MM:SS formats
        # Captures days*, hours*, minutes, and seconds -> *optional
        match = re.match(r"(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)", uptime)
        if not match:
            raise ValueError(f"Unrecognized etime format: {uptime}")

        days, hours, minutes, seconds = match.groups(default="0")
        return int(days) * 86400 + int(hours) * 3600 + int(minutes) * 60 + int(seconds)


def load_jupyter_server_extension(nbapp):
    web_app = nbapp.web_app
    route = url_path_join(web_app.settings["base_url"], "/uptime")
    web_app.add_handlers(".*", [(route, UptimeHandler)])
