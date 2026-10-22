# Send a page

The lab publishes small static pages at `https://edumpyard.github.io/lab/<name>/`.
You send a page as an issue in this repository. Each page is reviewed before it goes live.
Everything you send is public: the issue, its comments and the page.

By sending a page you confirm: I have the right to publish this. It is public. The lab may remove it at any time.

## What a page may hold

- `index.html` at the top, plus other files in folders below it.
- At most 200 files and 25 MB in total.
- File types: `html htm css js mjs json txt png jpg jpeg gif webp avif ico woff woff2 ttf otf mp3 mp4 webm`.
  Anything else is refused, for example `svg`, `xml`, `wasm`, `pdf`, archives, programs and files without an extension.
- File and folder names: no `..`, no names starting with `.`, no backslash, colon or control characters,
  at most 255 bytes per path, and no two names that differ only in upper and lower case.
- The page loads nothing from other sites. Scripts, styles, images, fonts and media must be files of the page
  (or `data:` and `blob:` URLs). Forms do not submit, workers do not start, and search engines do not index the page.
- The lab chooses the page name. You cannot choose it.

Not allowed: anything illegal, phishing or log-in look-alikes, malware, crypto mining, tracking, deceptive downloads,
content that targets a person, or pages that pretend to be someone else.

## Option 1: a zip, in the browser

1. Open a new issue with the **Page** form.
2. Keep the title `New page`.
3. Attach a `.zip` with `index.html` at the top (a single top folder in the zip is fine).
4. Tick the box and submit.

## Option 2: text, from the command line

Needs Node.js 22 or later and the GitHub CLI (`gh`), signed in. The page goes in the issue as text,
split into at most 10 parts of 60,000 characters (about 600 KB in total; larger pages need option 1).

```
curl -fsSLO https://raw.githubusercontent.com/edumpyard/lab/main/intake/intake.mjs
node intake.mjs pack <page-folder> <out-folder>
```

`pack` checks the folder, writes `<out-folder>/body.md` (and `part-2.md`, `part-3.md` and so on for a larger page)
and prints the exact commands to run. They look like this:

```
gh issue create --repo edumpyard/lab --title "New page" --body-file <out-folder>/body.md
gh issue comment <issue number> --repo edumpyard/lab --body-file <out-folder>/part-2.md
```

Post the parts in order, from the same account that opened the issue, a few seconds apart.
Do not edit the issue or the parts after posting them; an edited part is refused.

### The format, if you cannot run `pack`

The issue body starts with the line `lab-submission v1`, then a JSON manifest in a ` ```json ` fence:

```json
{"files": [{"path": "index.html", "encoding": "utf8", "part": 1}], "parts": 1, "sha256": "<checksum>"}
```

Then one block per file of that part, in manifest order. A block is the line `~~~~~~ <path>`, the file content,
and the line `~~~~~~`. The line end before the closing `~~~~~~` is not part of the file. Use `"encoding": "base64"`
(content as base64, line breaks allowed) for binary files and for text that holds a carriage return or a line that is
exactly `~~~~~~`. Each further part is a comment that starts with the line `lab-submission part K/N`, followed by the
blocks of the files whose `part` is K.

`sha256` is the SHA-256 of, for every file in byte order of its UTF-8 path: the path, a zero byte, the file size in
bytes as decimal digits, a zero byte, then the file bytes.

## Replace or remove your page

Only the account that sent a page can change it.

- Replace: send the page again with the title `Update <name>`. It is reviewed again; the name stays.
- Remove: open an issue titled `Remove <name>` (no content). It is removed without review. The name is not reused.

## Replies

The lab answers with one fixed line and never repeats your text.

| Reply | Meaning |
| :- | :- |
| `Received. Waiting for review.` | The format is fine. The issue is locked while it waits. |
| `Approved. Publishing now.` | Accepted at review. The issue stays open until the page is live. |
| `Live: <link>` | Published and live. Later changes can take up to 10 minutes to show. |
| `Removed.` | Your page is gone. |
| `Closed: TOO_BIG` | Over a limit. |
| `Closed: BAD_FORMAT` | The title, the manifest, a block, a path, the file types or the checksum is wrong. |
| `Closed: TOO_MANY_PARTS` | More than 10 parts. |
| `Closed: NOT_AUTHOR` | Not your page, or not sent by a personal account. |
| `Closed: ONE_OPEN_ONLY` | You already have an open issue here. Close it or wait for its answer. |
| `Closed: NO_TERMS` | The form box was not ticked. |
| `Closed: CONTENT`, `NOT_STATIC`, `OTHER` | Not accepted at review. |
