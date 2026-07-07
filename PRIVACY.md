# CardMirror Privacy Policy

**Last updated: July 7, 2026**

CardMirror is a writing and research tool for debate and academic work. This
policy explains, in plain language, what happens to your data when you use it.

The short version: **CardMirror keeps your work on your own device.** There are
no accounts, no logins, and no advertising or analytics tracking. A few
optional features connect to the internet — and when they do, the things you
share are **end‑to‑end encrypted**, meaning our server passes them along
without being able to read them. This policy spells out exactly what each
feature sends, what (if anything) is stored, and for how long.

> CardMirror is open source. If a description here is ever unclear, the code is
> the ground truth, and you're welcome to read or self‑host it.

---

## 1. What we *don't* do

- **No accounts.** You don't sign up, log in, or give us an email, phone number,
  or password. There is no account to create and none to breach.
- **No tracking or analytics.** CardMirror contains no analytics SDKs, no
  advertising trackers, and no usage telemetry. We do not build a profile of
  you or sell, rent, or trade anyone's data. We never have.
- **No reading your documents.** Your cards and documents live on your device.
  We have no server that stores your readable documents, and no ability to read
  the content you share through the optional server features (see §3–4).

---

## 2. Data stored on your device

Almost everything CardMirror knows about you stays on your own computer:

- Your documents and cards, and unsaved‑work recovery journals.
- Your settings and preferences (including any API keys or a display name you
  enter — see below).
- Your recent‑files list, pinned items, quick cards, and study annotations.
- If you use card sharing: a cryptographic key pair generated on your device,
  and an inbox of cards others have sent you.
- If you use co‑editing: a local record of your collaboration sessions.

**Retention:** this data stays on your device until *you* delete it (delete the
file, clear the item, or uninstall the app). We can't reach it and we don't
retain a copy. Anyone with access to your computer or account may be able to
read it, so protect your device as you would any folder of personal files.

---

## 3. Card sharing (optional — off by default)

Card sharing lets you send a card to someone else. It is **off until you turn it
on** in Settings.

- **How it's protected.** Before a card leaves your device it is **end‑to‑end
  encrypted** to the specific recipient (X25519 key exchange + AES‑256‑GCM). Only
  the intended recipient's device can decrypt it. Our relay server relays the
  encrypted bundle without the ability to read it.
- **Your identifier.** Your "pairing code" is your device's public key, which you
  choose to share with people you want to exchange cards with. You may also set
  an optional **display name**; it travels *inside the encrypted message* to your
  recipients and is never visible to the relay.
- **What the relay can see.** To route a message the relay sees a **recipient
  routing code** (a one‑way hash of the recipient's public key — not a name or
  email), a message id, the message's size, and timestamps. It does **not** see
  the card's content, and it does **not** learn who sent the message (the
  sender's identity is inside the encryption).
- **Retention:** an encrypted message is deleted from the relay **as soon as the
  recipient's device downloads it**, and in any case is **automatically deleted
  after 3 hours** whether or not it was delivered.

---

## 4. Co‑editing / live collaboration (optional — off by default)

Co‑editing lets two people edit the same document together in real time. It is a
desktop‑only feature that is **off by default** and must be deliberately enabled.

- **How it's protected.** Everything exchanged in a session — document edits,
  comments, and cursor presence — is **end‑to‑end encrypted** with a key that
  exists only in the invite/share link and on the participants' devices. The
  relay stores and forwards encrypted data it cannot read.
- **What's stored while a session runs.** So that someone can join or reconnect,
  the relay temporarily holds the session's **encrypted** edit history and
  periodic **encrypted** snapshots. **Live presence** (cursors and display names)
  is only relayed between participants in the moment and is **never stored**.
- **Retention:**
  - When the host chooses **"End session,"** the encrypted session data is
    **deleted from the relay immediately**.
  - Otherwise, an inactive session's encrypted data is **automatically deleted
    after 7 days of inactivity**.
  - Each participant's local record of the session stays on their device until
    they leave/end the session or clear it.

---

## 5. AI features (optional — off by default, your own key)

CardMirror's AI features (such as citation generation, flashcard creation, and
text cleanup) are **off by default**. To use them you enter **your own Anthropic
API key**, which is stored **locally** on your device and sent only to Anthropic.

When you invoke an AI feature, the relevant content — the text you selected,
surrounding document text, any image you ask it to look at, and your prompt — is
sent directly from your device to **Anthropic** (`api.anthropic.com`) to produce
the result. That content is handled under **Anthropic's** terms and privacy
policy, not ours; we neither see nor store it. If you don't enter a key and don't
use these features, nothing is ever sent to Anthropic.

---

## 6. Translation (optional, user‑invoked)

If you use the translate action, the text to be translated is sent to a
translation service:

- **MyMemory** (`api.mymemory.translated.net`) is the default and requires no
  key; the text you translate is sent to that third‑party service.
- **Google Cloud Translation** is available if you supply your own Google API
  key.

Translated text is handled under the chosen provider's terms. If you never use
the translate action, no text is sent to a translation service.

---

## 7. Software updates and downloads

- **Update checks** are **off by default**. If you turn them on (or check
  manually), the app asks **GitHub** whether a newer release exists; this reveals
  your IP address and the app version to GitHub but sends no document content.
- **Voice dictation**, if you enable it, performs a **one‑time download** of a
  speech model from its host (`alphacephei.com`). This reveals your IP address to
  that host but sends no document content; speech recognition then runs **entirely
  on your device**.

---

## 8. Crash handling

If CardMirror crashes, it writes diagnostic information (a crash dump and a short
local log) **to your device only**. Crash data is **never uploaded** anywhere. If
you want to help us fix a bug, you can open your crash‑dumps folder and choose to
send a file to us yourself.

---

## 9. The relay server and connection metadata

The optional card‑sharing and co‑editing features connect to a **relay server**.
The official relay is operated by us and hosted on **Railway** (a cloud provider
in the United States). Because the relay only ever handles **end‑to‑end‑encrypted**
data, it cannot read your cards, documents, comments, or messages.

Like any internet service, the relay and its hosting provider necessarily see
**connection metadata** — most notably your **IP address** and the time and
duration of your connection — which is inherent to delivering data over the
internet and may be retained in standard server access logs per the hosting
provider's practices. The relay's own application logs record only truncated
routing identifiers and counts, never content.

A relay access token gates use of the server to limit abuse; it is **not** the
mechanism that protects your privacy — the end‑to‑end encryption is. CardMirror
can also be pointed at a **self‑hosted relay**; if you or your organization run
your own, that server is under your control and this section describes only the
official relay.

---

## 10. Third parties

We do not share your data with third parties for their own purposes, and we run
no advertising or analytics. Data reaches an outside service **only** when you use
a feature that inherently requires it, and only to the extent that feature needs:

| Service | When it's contacted | What it receives |
|---|---|---|
| **Railway** (relay host) | Card sharing / co‑editing (opt‑in) | End‑to‑end‑encrypted data it can't read; connection metadata incl. IP |
| **Anthropic** | AI features (opt‑in, your key) | The text/images and prompt you submit |
| **MyMemory / Google** | Translate action | The text you translate |
| **GitHub** | Update checks (opt‑in) | Your IP address and app version |
| **alphacephei.com** | First‑time voice‑model download (opt‑in) | Your IP address |

Each third party handles what it receives under its own privacy policy.

---

## 11. Children's privacy

CardMirror is a general‑purpose writing tool intended for a general audience,
which may include high‑school and college students. It is **not directed to
children under 13**, and because it has no accounts and stores work on your own
device, we generally do not collect personal information from anyone. We do not
knowingly collect personal information from children under 13 through the server
features. If you believe a child under 13 has provided personal information
through the relay, please contact us (§14) and we will help remove it.

If your school or organization deploys CardMirror for students, that
institution's own policies and agreements also apply.

---

## 12. Your controls and how to delete your data

- **Local data:** delete a document, clear an inbox item, or uninstall the app to
  remove data from your device.
- **A shared card:** it self‑deletes from the relay on delivery, and within 3
  hours regardless. You can also regenerate your pairing code, which invalidates
  any cards still addressed to your old code.
- **A collaboration session:** the host's **"End session"** deletes the session's
  data from the relay immediately; otherwise it expires after 7 days of
  inactivity. You can also clear a session's local record on your device.
- **API keys / display name:** clear the corresponding field in Settings.

Because we don't hold an account or a readable copy of your work, there is no
central profile for us to delete — deletion happens where the data lives (your
device) or via the automatic relay expiry above.

---

## 13. Changes to this policy

If we make a material change to how CardMirror handles data, we will update this
policy and its "Last updated" date, and note significant changes in the app's
release notes.

---

## 14. Contact

Questions about this policy or your data? Contact us at **ant981228@gmail.com**
or by opening an issue at **https://github.com/ant981228/cardmirror**.
