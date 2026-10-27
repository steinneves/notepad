# Public Notepad

A one-page website with a single shared notepad. Anyone who opens it can read
and edit the same text, and changes show up for everyone else within about a
second. No accounts, no logins.

- **Website hosting:** GitHub Pages (free)
- **Where the text is stored:** Supabase (free tier)

---

## What each file does

| File | What it is |
|---|---|
| `index.html` | The page itself |
| `style.css` | How it looks (light and dark mode follow your device setting) |
| `app.js` | Loads, saves and live-updates the text |
| `merge.js` | Combines two people's edits when they type at the same time |
| `config.js` | Your Supabase address and **public** key |
| `supabase/setup.sql` | Creates the database. You paste it into Supabase once. |
| `.github/workflows/keep-alive.yml` | A daily job that stops Supabase from pausing |

---

## One-time setup

### 1. Create the database

1. Open your project at [supabase.com](https://supabase.com).
2. In the left sidebar, click **SQL Editor**.
3. Click **New query**. (A **+** button may be shown instead.)
4. Open `supabase/setup.sql`, copy **all** of it, and paste it into the editor.
5. Click **Run** in the bottom right.
6. You should see **"Success. No rows returned."**

You can run this file again at any time. It won't erase the notepad text.

### 2. Turn on GitHub Pages

1. On github.com, open this repository.
2. Click **Settings**, then **Pages** in the left menu.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Under **Branch**, choose **notepad** and **/ (root)**, then click **Save**.
5. After a minute or two, the page shows your site's address, for example
   `https://YOURNAME.github.io/notepad/`.

### 3. Check that the keep-alive job works

No secrets are needed. The job reads the address and public key from `config.js`.

1. In the repository, click the **Actions** tab.
2. If GitHub asks you to enable workflows, click the green button.
3. Click **Keep Supabase awake** on the left, then **Run workflow**, then the
   green **Run workflow** button.
4. After about 30 seconds, refresh the page. A green check ✅ means it worked.
   From now on it runs by itself once a day.

---

## Testing with two browser tabs

1. Open your site in two tabs side by side. A private/incognito window
   works too, as does your phone.
2. Bottom left of both tabs should show a green dot with **Connected**.
3. Type in tab A. Within about a second, the text appears in tab B. Tab A
   briefly shows **Saving…** and then goes back to **Connected**.
4. Put your cursor in the middle of the text in tab B and leave it there.
   Then type at the end of the text in tab A. Tab B should update, and its
   cursor should stay where you left it.
5. Type at the start of the text in tab A and at the end in tab B at the same
   time. After a couple of seconds, both tabs should show both edits.
6. Turn off Wi-Fi and type in one tab. It shows a red dot with **Offline**.
   Turn Wi-Fi back on, and your text saves and shows up in the other tab.
7. Paste a very long text. The counter at the bottom right stops at
   10,000 and turns red.

---

## Undoing vandalism (restoring an old version)

Every time the text changes, the database saves the previous version, at most
once a minute. Old versions are kept for 14 days. The public cannot see
or change these copies.

1. In Supabase, open **SQL Editor** → **New query**.
2. Paste the following and click **Run** to list recent versions:

   ```sql
   select id, saved_at, left(content, 200) as preview
   from notepad_history
   order by saved_at desc
   limit 50;
   ```

3. Find the version you want by its time and preview. Note its **id**
   number. Times are shown in UTC.
4. Replace everything in the editor with the following. Change `123` to that
   id number, then click **Run**:

   ```sql
   update notepad
   set content = (select content from notepad_history where id = 123)
   where id = 1;
   ```

5. Everyone's page updates right away. If you get a *rate_limited* error,
   someone else saved in the same second. Just click **Run** again.

### Emergency: make the notepad read-only

If someone keeps vandalizing it, run this to stop all public edits:

```sql
drop policy "public can update the notepad" on public.notepad;
```

To allow editing again, run `supabase/setup.sql` again.

---

## Limits and safety notes

- Anyone with the link can change or erase the text. That is the point of
  the site, so restore from history if needed.
- Edits are limited to 10,000 characters and to one save per second for the
  whole notepad.
- If two people edit the **same spot** at the same moment, the most recent save
  wins. Edits in different places are combined.
- The key in `config.js` is the **publishable** key. It's meant to be visible.
  **Never** put the `secret` / `service_role` key in this repository.
- To use a different Supabase project, change both values in `config.js`.
