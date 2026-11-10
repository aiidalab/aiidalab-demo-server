define(["base/js/namespace", "base/js/utils"], (Jupyter, utils) => {
  const EXTENSION = "aiidalab-session-timer";
  const WARNING_THRESHOLD = 30 * 60;
  const CRITICAL_THRESHOLD = 5 * 60;

  let interval = null;

  const baseUrl = utils.get_body_data("baseUrl");
  const assetUrl = (file) => `${baseUrl}nbextensions/${EXTENSION}/${file}`;

  const parseLifetimeToSeconds = (value) => {
    // Supports MM:SS, HH:MM:SS, and D-HH:MM:SS.
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());

    if (!match) {
      throw new Error(`Invalid container lifetime: ${value}`);
    }

    const [, days = "0", hours = "0", minutes, seconds] = match;

    return (
      Number(days) * 86400 +
      Number(hours) * 3600 +
      Number(minutes) * 60 +
      Number(seconds)
    );
  };

  const formatTime = (seconds) => {
    const remaining = Math.max(0, Math.ceil(seconds));

    const hrs = String(Math.floor(remaining / 3600)).padStart(2, "0");
    const mins = String(Math.floor((remaining % 3600) / 60)).padStart(2, "0");
    const secs = String(remaining % 60).padStart(2, "0");

    return `${hrs}:${mins}:${secs}`;
  };

  const fetchJson = async (url) => {
    const response = await fetch(url, {
      credentials: "same-origin",
    });

    if (!response.ok || response.redirected) {
      throw new Error(
        `Request failed: ${url} (${response.status}, ` +
          `redirected=${response.redirected})`,
      );
    }

    return response.json();
  };

  const loadStylesheet = () => {
    if (document.getElementById(`${EXTENSION}-stylesheet`)) {
      return;
    }

    const stylesheet = document.createElement("link");
    stylesheet.id = `${EXTENSION}-stylesheet`;
    stylesheet.rel = "stylesheet";
    stylesheet.href = assetUrl("style.css");

    document.head.appendChild(stylesheet);
  };

  const insertCountdown = (remainingSeconds) => {
    if (document.getElementById("culling-countdown")) {
      return;
    }

    const header = document.getElementById("header");

    if (!header) {
      console.warn("Session timer: notebook header not found");
      return;
    }

    const banner = document.createElement("div");
    banner.id = "culling-countdown";

    const shutdownWarning = document.createElement("div");
    shutdownWarning.id = "shutdown-warning";
    shutdownWarning.textContent = "⚠️ Shutdown imminent! ⚠️";
    shutdownWarning.style.display = "none";
    banner.appendChild(shutdownWarning);

    const countdown = document.createElement("div");
    countdown.id = "countdown";
    countdown.append("Session time remaining: ");

    const timer = document.createElement("span");
    timer.id = "culling-timer";
    timer.textContent = "Calculating...";
    countdown.appendChild(timer);
    banner.appendChild(countdown);

    const saveInfo = document.createElement("div");
    saveInfo.id = "save-info";
    saveInfo.innerHTML =
      "Consider saving your work using the " +
      "<b>File Manager</b> or the <b>Terminal</b>";
    saveInfo.style.display = "none";
    banner.appendChild(saveInfo);

    header.parentNode.insertBefore(banner, header);

    const endTime = Date.now() + remainingSeconds * 1000;

    const updateTimer = () => {
      const timeLeft = Math.max(0, (endTime - Date.now()) / 1000);

      const warning = timeLeft <= WARNING_THRESHOLD;
      const critical = timeLeft <= CRITICAL_THRESHOLD;

      saveInfo.style.display = warning ? "block" : "none";
      shutdownWarning.style.display = critical ? "block" : "none";

      banner.classList.toggle("warning", warning && !critical);
      banner.classList.toggle("critical", critical);

      timer.textContent = formatTime(timeLeft);

      if (timeLeft <= 0 && interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    updateTimer();

    if (remainingSeconds > 0) {
      interval = setInterval(updateTimer, 1000);
    }
  };

  const loadCountdown = async () => {
    try {
      const config = await fetchJson(assetUrl("config.json"));

      if (!config.ephemeral) {
        return;
      }

      if (!config.lifetime) {
        console.warn("Session timer: missing container lifetime");
        return;
      }

      const lifetime = parseLifetimeToSeconds(config.lifetime);
      const uptime = await fetchJson(`${baseUrl}uptime`);

      if (typeof uptime.uptime !== "number") {
        throw new Error("Invalid uptime response");
      }

      insertCountdown(Math.max(0, lifetime - uptime.uptime));
    } catch (error) {
      console.error("Session timer initialization failed:", error);
    }
  };

  const load_ipython_extension = () => {
    loadStylesheet();
    loadCountdown();
  };

  return { load_ipython_extension };
});
