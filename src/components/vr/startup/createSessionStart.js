import { startup } from "@/components/vr/startup/startupReport";

/*
  Getting an immersive session — and keeping it.

  The runtime under the packaged app is an OpenXR host, and it is strict about
  the order it hands sessions out in:

  - It only pumps XR frames once its own OpenXR session has begun (xrBeginSession,
    which it calls when OpenXR reports READY). A request made before that is HELD
    by the host and opened on the state event that says it has begun — and the
    host publishes that event while the page is still flat, on purpose, so a page
    that asked early is not left waiting.
  - A session opened while the runtime is READY or SYNCHRONIZED starts HIDDEN:
    its frames carry no view poses until the runtime reaches VISIBLE or FOCUSED,
    and the host then says so with a visibilitychange.

  Everything below follows from one rule:

  ASK ONCE, AND NEVER GIVE THE SESSION BACK.

  A granted session is the app's only way onto the screen. On the headset the
  flat page is not composited at all, so ending a session leaves a black view
  that nothing brings the game back from — the host's autoEnter is one-shot, and
  its own session has already been ended. A hidden session is therefore waited
  out, never thrown away: the host is already on its way to VISIBLE and will say
  so.

  Only a REFUSAL is retried — a request the runtime turned down before any
  session existed.
*/

const SPACES = ["local-floor", "local"];
// How long a held request may stay silent before the card says why.
const HOLD_NOTICE = 8000;
// Refusals to tolerate before the game settles for flat.
const MAX_ATTEMPTS = 12;

export function createSessionStart({ renderer, onStatus, onMessage, onSessionLost }) {
  let stopped = false;
  let attempts = 0;
  let pending = null;
  let session = null;
  let running = null;
  let timer = null;
  let holdTimer = null;
  let phase = "idle";

  const say = (status, message) => {
    if (onStatus) onStatus(status);
    if (onMessage) onMessage(message);
  };

  const shown = (target) => Boolean(target && target.visibilityState === "visible");

  const stopTimer = (handle) => {
    if (handle) clearTimeout(handle);
    return null;
  };

  const schedule = (delay) => {
    timer = stopTimer(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      attempt();
    }, delay);
  };

  const settle = (label, detail, status, message) => {
    phase = status === "in-vr" ? "live" : "flat";
    startup.step("session", label, status === "in-vr" ? 0.42 : 0.3, detail);
    say(status, message);
  };

  /** Attach the session to the renderer, falling back to a plainer space. */
  const attach = async (target) => {
    for (const type of SPACES) {
      try {
        renderer.xr.setReferenceSpaceType(type);
        await renderer.xr.setSession(target);
        return type;
      } catch (error) {
        startup.step("session", `Reference space ${type} refused`, 0.3, String((error && error.name) || error));
      }
    }
    return null;
  };

  const live = (target) => {
    session = target;
    settle(
      "VR session running",
      `visibility ${target.visibilityState}`,
      "in-vr",
      "Live in headset — exit from the Quest menu"
    );

    target.addEventListener(
      "end",
      () => {
        const ours = session === target;
        if (ours) session = null;
        if (stopped) return;
        startup.step("session", "Session ended", 0.3, "");
        say("ready", "Session ended");
        // three drops its XR loop with the session; the world puts its own back.
        if (ours && onSessionLost) onSessionLost("the session ended");
      },
      { once: true }
    );
  };

  /**
   * A session that is not visible yet. It is kept, not handed back: the runtime
   * makes it visible on its own when it reaches VISIBLE / FOCUSED, and that is
   * the event waited for here.
   */
  const watch = (target) => {
    if (shown(target)) {
      live(target);
      return;
    }

    startup.step("session", "Session opened hidden", 0.3, `visibilityState: ${target.visibilityState}`);
    say("ready", "Waiting for the headset to show the game…");

    const onVisible = () => {
      if (!shown(target)) return;
      target.removeEventListener("visibilitychange", onVisible);
      startup.step("session", "Session visible", 0.34, "");
      live(target);
    };
    target.addEventListener("visibilitychange", onVisible);
  };

  const run = async () => {
    if (stopped || session) return;
    if (renderer.xr.isPresenting) return;

    if (!navigator.xr) {
      settle(
        "No WebXR here",
        "navigator.xr is missing",
        "unsupported",
        "WebXR is not available here — open this page in the Meta Quest browser."
      );
      return;
    }

    if (pending) {
      startup.step("session", "Waiting for the headset", 0.16, "the runtime has not begun its session yet");
      say("ready", "Waiting for the headset…");
    } else {
      attempts += 1;
      startup.step("session", "Asking for an immersive session", 0.16, `attempt ${attempts}`);
      say("ready", attempts === 1 ? "Starting session…" : `Waiting for the headset… (${attempts})`);

      /*
        The one and only request. If the runtime holds it until its session
        begins, it stays held here — a second request while this one is pending
        is refused as "already active", and chasing that refusal is what a
        startup that never finishes is made of.
      */
      pending = navigator.xr.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor"],
      });

      holdTimer = stopTimer(holdTimer);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        startup.step("session", "Headset has not answered yet", 0.16, "put the headset on to start VR");
        say("ready", "Waiting for the headset…");
      }, HOLD_NOTICE);
    }

    let target = null;
    try {
      target = await pending;
      pending = null;
      holdTimer = stopTimer(holdTimer);
    } catch (error) {
      pending = null;
      holdTimer = stopTimer(holdTimer);

      const name = (error && error.name) || "Error";
      const detail = (error && (error.message || error.name)) || "unknown error";
      startup.step("session", `Session refused: ${name}`, 0.16, detail);

      // A browser refusing a session nobody clicked for is the normal answer.
      const needsClick = name === "NotAllowedError" || name === "SecurityError";
      if (needsClick) {
        settle("Waiting for a tap", detail, "ready", "Tap the scene to start VR");
        return;
      }

      if (attempts >= MAX_ATTEMPTS) {
        settle("VR could not start", detail, "ready", `Could not start VR: ${detail}`);
        return;
      }

      schedule(name === "InvalidStateError" ? 1200 : 700);
      return;
    }

    if (!target) return;
    if (session || renderer.xr.isPresenting) return;

    startup.step("session", "Session granted", 0.24, "");
    const space = await attach(target);

    if (!space) {
      /*
        No reference space was accepted. This is the one case where the session
        is handed back, because it cannot be drawn into at all — but the page
        keeps asking afterwards, since a runtime that refused a space has not
        ended its own session.
      */
      try {
        await target.end();
      } catch (error) {
        /* ignored */
      }
      if (attempts >= MAX_ATTEMPTS) {
        settle("VR could not start", "no reference space was accepted", "ready", "The headset refused every reference space.");
        return;
      }
      schedule(900);
      return;
    }

    startup.step("session", `Session attached · ${space}`, 0.34, "");
    watch(target);
  };

  /** One attempt at a time: a repeated call joins the one already running. */
  const attempt = () => {
    if (running) return running;
    running = run().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    /** Start asking. Called at mount, not on a timer. */
    begin(delay = 0) {
      schedule(delay);
    },

    /** The player pressed Start session, or tapped the scene. */
    retry() {
      attempts = 0;
      phase = "idle";
      attempt();
    },

    /** Where the session stands, for the diagnostics line. */
    state: () => ({ phase, attempts, pending: Boolean(pending), session: Boolean(session) }),

    stop() {
      stopped = true;
      timer = stopTimer(timer);
      holdTimer = stopTimer(holdTimer);
      const target = session || pending;
      session = null;
      pending = null;
      if (target && typeof target.then === "function") {
        target.then((value) => value && value.end && value.end().catch(() => {})).catch(() => {});
      } else if (target && target.end) {
        target.end().catch(() => {});
      }
    },
  };
}