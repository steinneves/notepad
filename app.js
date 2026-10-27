(function () {
  "use strict";

  const MAX_LENGTH = 10000;
  const SAVE_DELAY = 400;     // save this long after typing stops
  const SAVE_MAX_WAIT = 2000; // ...but at least this often while typing nonstop
  const MIN_SAVE_GAP = 1100;  // the database rejects saves less than 1s apart
  const POLL_INTERVAL = 1000; // how often to check for edits from other tabs/devices
  const RETRY_DELAY = 3000;

  const { merge3, moveCursor } = window.NotepadMerge;
  const config = window.NOTEPAD_CONFIG;

  const lockForm = document.getElementById("lock");
  const passwordInput = document.getElementById("password");
  const unlockButton = document.getElementById("unlock");
  const lockMessage = document.getElementById("lock-message");
  const main = document.querySelector("main");
  const footer = document.querySelector("footer");
  const pad = document.getElementById("pad");
  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("status-text");
  const countEl = document.getElementById("count");

  const LOCK_MESSAGES = {
    wrong: "Wrong password.",
    locked: "Too many wrong attempts. Try again in an hour.",
    not_set: "No password has been set up yet.",
  };

  let password = null;      // kept in memory only; reloading the page asks again
  let base = null;          // { text, version }: the latest text known to be saved on the server
  let pendingRemote = null; // a server update that arrived while we couldn't apply it yet
  let saving = false;
  let polling = false;
  let composing = false;    // true while an input method (e.g. for Chinese/Japanese) is mid-word
  let live = false;         // true while the last check with the server succeeded
  let lastError = null;
  let saveTimer = null;
  let pollTimer = null;
  let lastSaveAt = 0;
  let dirtySince = 0;

  // Calls one of the database functions defined in supabase/setup.sql.
  async function rpc(name, args) {
    const response = await fetch(config.supabaseUrl + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: { apikey: config.supabaseKey, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(name + " failed with HTTP " + response.status);
    return response.json();
  }

  function isDirty() {
    return base !== null && pad.value !== base.text;
  }

  function render() {
    let state, text;
    if (!navigator.onLine) {
      state = "offline";
      text = isDirty() ? "Offline – changes not saved yet" : "Offline";
    } else if (lastError) {
      state = "error";
      text = lastError;
    } else if (saving || isDirty()) {
      state = "saving";
      text = "Saving…";
    } else if (!live) {
      state = "offline";
      text = "Reconnecting…";
    } else {
      state = "connected";
      text = "Connected";
    }
    statusEl.dataset.state = state;
    statusText.textContent = text;

    const n = pad.value.length;
    countEl.textContent = n.toLocaleString("en-US") + " / " + MAX_LENGTH.toLocaleString("en-US");
    countEl.classList.toggle("full", n >= MAX_LENGTH);
  }

  // Replace the textarea's text without moving the user's cursor or scroll position.
  function setText(text) {
    const old = pad.value;
    if (text === old) return;
    const focused = document.activeElement === pad;
    const { selectionStart, selectionEnd, selectionDirection, scrollTop } = pad;
    pad.value = text;
    if (focused) {
      pad.setSelectionRange(
        moveCursor(selectionStart, old, text),
        moveCursor(selectionEnd, old, text),
        selectionDirection
      );
    }
    pad.scrollTop = scrollTop;
  }

  // Back to the password screen, forgetting the password and the text.
  function lock(reason) {
    password = null;
    base = null;
    pendingRemote = null;
    live = false;
    lastError = null;
    clearTimeout(saveTimer);
    clearTimeout(pollTimer);
    pad.value = "";
    main.hidden = true;
    footer.hidden = true;
    lockForm.hidden = false;
    lockMessage.textContent = LOCK_MESSAGES[reason] || "";
    passwordInput.value = "";
    passwordInput.focus();
  }

  // A newer version arrived from the server: merge it with anything typed here.
  function reconcile(row) {
    if (!row || base === null || row.version <= base.version) return;
    if (saving || composing) {
      if (!pendingRemote || row.version > pendingRemote.version) pendingRemote = row;
      return;
    }
    const merged = merge3(base.text, pad.value, row.content);
    base = { text: row.content, version: row.version };
    // merged is null when both edited the same spot; keep what's being typed here.
    if (merged !== null) setText(merged);
    if (isDirty()) scheduleSave();
    render();
  }

  function applyPending() {
    const row = pendingRemote;
    pendingRemote = null;
    reconcile(row);
  }

  function scheduleSave(delay) {
    if (!dirtySince) dirtySince = Date.now();
    const now = Date.now();
    const wait = Math.max(
      Math.min(delay ?? SAVE_DELAY, dirtySince + SAVE_MAX_WAIT - now),
      lastSaveAt + MIN_SAVE_GAP - now,
      0
    );
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, wait);
  }

  async function save() {
    saveTimer = null;
    if (password === null) return;
    if (saving || composing || !isDirty()) {
      if (!isDirty()) dirtySince = 0;
      render();
      return;
    }
    if (!navigator.onLine) {
      render(); // the "online" event will retry
      return;
    }
    const text = pad.value;
    if (text.length > MAX_LENGTH) {
      lastError = "Too long – shorten to save";
      render();
      return;
    }

    saving = true;
    lastSaveAt = Date.now();
    render();
    let retryIn = null;
    try {
      const result = await rpc("notepad_save", { pw: password, new_content: text, base_version: base.version });
      if (LOCK_MESSAGES[result.status]) {
        saving = false;
        lock(result.status);
        return;
      }
      lastError = null;
      live = true;
      if (result.status === "saved") {
        if (result.version > base.version) base = { text, version: result.version };
      } else if (result.status === "conflict") {
        // Saved from somewhere else first; their text gets merged below.
        if (!pendingRemote || result.version > pendingRemote.version) pendingRemote = result;
      } else if (result.status === "rate_limited") {
        retryIn = 1000;
      } else if (result.status === "too_long") {
        lastError = "Too long – shorten to save";
      }
    } catch (err) {
      console.warn("Save failed:", err);
      lastError = "Couldn't save – retrying";
      retryIn = RETRY_DELAY;
    }
    saving = false;
    applyPending();
    if (isDirty() && !(lastError && lastError.startsWith("Too long"))) scheduleSave(retryIn ?? SAVE_DELAY);
    else if (!isDirty()) dirtySince = 0;
    render();
  }

  async function poll() {
    clearTimeout(pollTimer);
    if (password === null) return;
    if (!polling && navigator.onLine && document.visibilityState === "visible") {
      polling = true;
      try {
        const result = await rpc("notepad_read", { pw: password, known_version: base.version });
        if (LOCK_MESSAGES[result.status]) {
          polling = false;
          lock(result.status);
          return;
        }
        live = true;
        if (lastError && lastError.startsWith("Couldn't")) lastError = null;
        if (typeof result.content === "string") reconcile(result);
      } catch (err) {
        console.warn("Check for updates failed:", err);
        live = false;
      }
      polling = false;
      render();
    }
    clearTimeout(pollTimer);
    if (password !== null) pollTimer = setTimeout(poll, POLL_INTERVAL);
  }

  lockForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const attempt = passwordInput.value;
    if (!attempt) return;
    unlockButton.disabled = true;
    lockMessage.textContent = "";
    try {
      const result = await rpc("notepad_read", { pw: attempt });
      if (result.status === "ok") {
        password = attempt;
        base = { text: result.content, version: result.version };
        pad.value = result.content;
        passwordInput.value = "";
        lockForm.hidden = true;
        main.hidden = false;
        footer.hidden = false;
        live = true;
        render();
        pad.focus();
        pollTimer = setTimeout(poll, POLL_INTERVAL);
      } else {
        lock(result.status);
      }
    } catch (err) {
      console.warn("Unlock failed:", err);
      lockMessage.textContent = "Couldn't connect. Check your internet and try again.";
    }
    unlockButton.disabled = false;
  });

  pad.addEventListener("input", function () {
    if (lastError && lastError.startsWith("Too long")) lastError = null;
    render();
    scheduleSave();
  });
  pad.addEventListener("compositionstart", function () {
    composing = true;
  });
  pad.addEventListener("compositionend", function () {
    composing = false;
    applyPending();
    scheduleSave();
  });

  window.addEventListener("online", function () {
    poll();
    if (isDirty()) scheduleSave();
    render();
  });
  window.addEventListener("offline", render);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") poll();
  });
  window.addEventListener("beforeunload", function (event) {
    if (isDirty()) event.preventDefault();
  });
})();
