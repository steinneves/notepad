(function () {
  "use strict";

  const MAX_LENGTH = 10000;
  const SAVE_DELAY = 400;    // save this long after typing stops
  const SAVE_MAX_WAIT = 2000; // ...but at least this often while typing nonstop
  const MIN_SAVE_GAP = 1100; // the database rejects updates less than 1s apart
  const RETRY_DELAY = 3000;

  const { merge3, moveCursor } = window.NotepadMerge;
  const config = window.NOTEPAD_CONFIG;

  const pad = document.getElementById("pad");
  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("status-text");
  const countEl = document.getElementById("count");

  const db = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let base = null;          // { text, version }: the latest text known to be saved on the server
  let pendingRemote = null; // a server update that arrived while we couldn't apply it yet
  let saving = false;
  let composing = false;    // true while an input method (e.g. for Chinese/Japanese) is mid-word
  let live = false;         // true while the realtime connection is up
  let lastError = null;
  let saveTimer = null;
  let lastSaveAt = 0;
  let dirtySince = 0;

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
    } else if (!live || base === null) {
      state = "connecting";
      text = "Connecting…";
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

  async function fetchRow() {
    const { data, error } = await db.from("notepad").select("content, version").eq("id", 1).single();
    if (error) throw error;
    return data;
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
    // merged is null when both people edited the same spot; keep what's being typed here.
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
      // Only save if nobody else has saved since our last known version.
      const { data, error } = await db
        .from("notepad")
        .update({ content: text })
        .eq("id", 1)
        .eq("version", base.version)
        .select("version")
        .maybeSingle();
      if (error) {
        if (/rate_limited/.test(error.message)) {
          retryIn = 1000;
        } else {
          console.warn("Save failed:", error);
          lastError = "Couldn't save – retrying";
          retryIn = RETRY_DELAY;
        }
      } else if (data) {
        lastError = null;
        if (data.version > base.version) base = { text, version: data.version };
      } else {
        // Someone else saved first. Fetch their text; it gets merged below.
        lastError = null;
        const latest = await fetchRow();
        if (!pendingRemote || latest.version > pendingRemote.version) pendingRemote = latest;
      }
    } catch (err) {
      console.warn("Save failed:", err);
      lastError = "Couldn't save – retrying";
      retryIn = RETRY_DELAY;
    }
    saving = false;
    applyPending();
    if (isDirty()) scheduleSave(retryIn ?? SAVE_DELAY);
    else dirtySince = 0;
    render();
  }

  async function load() {
    try {
      const row = await fetchRow();
      if (base === null) {
        base = { text: row.content, version: row.version };
        pad.value = row.content;
        pad.readOnly = false;
        pad.placeholder = "Start typing…";
      } else {
        reconcile(row);
      }
      if (lastError && lastError.startsWith("Couldn't load")) lastError = null;
    } catch (err) {
      console.warn("Load failed:", err);
      lastError = "Couldn't load – retrying";
      setTimeout(load, RETRY_DELAY);
    }
    render();
  }

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
    load();
    if (isDirty()) scheduleSave();
    render();
  });
  window.addEventListener("offline", render);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") load();
  });
  window.addEventListener("beforeunload", function (event) {
    if (isDirty()) event.preventDefault();
  });

  db.channel("notepad")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "notepad", filter: "id=eq.1" },
      function (payload) { reconcile(payload.new); }
    )
    .subscribe(function (status) {
      live = status === "SUBSCRIBED";
      if (live) load(); // catch up on anything missed while disconnected
      render();
    });

  render();
  load();
})();
