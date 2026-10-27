# Private Notepad

A one-page website with a single notepad, locked behind a password. After
you enter the password, edits sync to your other open tabs and devices
within about a second. Nothing is sent to the browser until the right
password is entered.

> ⚠️ **Any wrong password erases the notepad text immediately**, with no
> warning. A copy is kept in the history (see "Restoring old text" below).
> After 10 wrong passwords in an hour, the notepad stays locked for an hour,
> even for the right password.

- **Website hosting:** GitHub Pages (free)
- **Where the text is stored:** Supabase (free tier)

---

## What each file does

| File | What it is |
|---|---|
| `index.html` | The page itself (password screen and notepad) |
| `style.css` | How it looks (light and dark mode follow your device setting) |
| `app.js` | Checks the password, then loads, saves and syncs the text |
| `merge.js` | Combines edits made in two places at the same time |
| `config.js` | Your Supabase address and **public** key |
| `supabase/setup.sql` | Creates the database. You paste it into Supabase once. |
| `.github/workflows/keep-alive.yml` | A daily job that stops Supabase from pausing |

The password is **not** stored in any of these files, because this repository
is public. It lives only in your Supabase database, in scrambled form.

---

## How it's protected

- The website can't read the database tables directly. It can only call
  three database functions: *read*, *save* and *ping*. *Read* and *save*
  check the password on the server every time.
- *Ping* is what the keep-alive job uses. It needs no password and only
  answers "yes, I'm awake".
- The password is stored as a bcrypt hash, a scrambled form that can't be
  turned back into the password.
- The page keeps the password only in memory. Reloading or closing the tab
  asks for it again.

---

## One-time setup

### 1. Create or update the database

1. Open your project at [supabase.com](https://supabase.com).
2. In the left sidebar, click **SQL Editor**, then **New query**.
3. Open `supabase/setup.sql`, copy **all** of it, and paste it into the editor.
4. Click **Run**. You should see **"Success. No rows returned."**

### 2. Set or change the password

1. In **SQL Editor**, click **New query**.
2. Paste the following, replacing `YOUR-PASSWORD` with your password, then
   click **Run**:

   ```sql
   update private.notepad_auth
   set password_hash = extensions.crypt('YOUR-PASSWORD', extensions.gen_salt('bf')),
       failed_count = 0, locked_until = null
   where id = 1;
   ```

3. Supabase may save this query in the SQL Editor's sidebar. Since it shows
   your password, you can delete it there: click **⋯** next to it, then
   **Delete**.

Don't put the password in any file in this repository.

### 3. GitHub Pages and the keep-alive job

These are already set up for this repository:
- GitHub Pages serves from the `notepad` branch.
- The **Keep Supabase awake** job runs daily. You can see it on the
  **Actions** tab.

---

## If you get locked out

After 10 wrong passwords, the notepad locks for an hour. To unlock it
right away, run this in **SQL Editor**:

```sql
update private.notepad_auth set failed_count = 0, locked_until = null where id = 1;
```

---

## Testing with two tabs

1. Open your site in two tabs and enter the password in both.
2. Type in tab A. Within about a second, the text appears in tab B.
3. Leave your cursor in the middle of the text in tab B, then type at the
   end in tab A. Tab B updates and its cursor stays put.
4. Type at the start in tab A and at the end in tab B at the same time.
   Both edits are kept.

---

## Restoring old text (after a wrong password, or anything else)

The database saves the previous text before each wrong-password wipe. It
also saves a copy at most once a minute while you edit. Copies are kept
for 14 days.

1. In Supabase, open **SQL Editor** → **New query**.
2. Paste the following and click **Run** to list recent versions:

   ```sql
   select id, saved_at, left(content, 200) as preview
   from notepad_history
   order by saved_at desc
   limit 50;
   ```

3. Find the version you want and note its **id** number. Times are in UTC.
4. Replace the query with this one, changing `123` to that id, and click **Run**:

   ```sql
   update notepad
   set content = (select content from notepad_history where id = 123)
   where id = 1;
   ```

5. Reload the site and enter the password. The restored text is there.

---

## Limits and safety notes

- **Anyone who finds the site can erase the text** by typing any wrong
  password. Nothing is lost permanently, because history keeps a copy. They
  can also lock you out for an hour by entering 10 wrong passwords.
- **A short password can be guessed.** The lock limits guessing to 10
  tries an hour, but that's still about 240 a day. A 4-digit password has
  only 10,000 possibilities, so a patient attacker could find it within a
  few weeks. A longer password makes this practically impossible.
- The notepad holds up to 10,000 characters and allows one save per second.
- If you edit the **same spot** in two places at the same moment, the most
  recent save wins. Edits in different places are combined.
- The key in `config.js` is the **publishable** key. It's meant to be visible.
  **Never** put the `secret` / `service_role` key in this repository.
