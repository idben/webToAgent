# webToAgent

English | [繁體中文](README.zh-TW.md)

Pick HTML elements in the browser, queue up multiple change requests, and send them to a CLI agent (Claude Code) in one batch. The page reloads automatically after the changes are made.

## Install from GitHub

Requires Node.js 20+, git, bash (macOS or WSL on Windows), and Claude Code. No dependencies, no `npm install` needed.

### Let Claude Code install it

Paste this into Claude Code:

```text
Install the webToAgent skill by following the README at https://github.com/idben/webToAgent
```

### Install manually

```bash
git clone https://github.com/idben/webToAgent.git
cd webToAgent
scripts/install-skill.sh
```

- Installs to `~/.claude/skills/webtoagent`
- Update: run `git pull` in the webToAgent folder, then run `scripts/install-skill.sh` again
- Uninstall: `rm -rf ~/.claude/skills/webtoagent`

## Use in Claude Code

Choose the usage that fits your project:

| Project | Command |
|---|---|
| Plain HTML | `/webtoagent <folder>` |
| Vue / React or other projects with a dev server | `/webtoagent`, or `/webtoagent --proxy <dev server URL>` |

- Without arguments: if the project has a `dev` script, Claude Code asks whether to start the dev server for you; otherwise it asks which folder to preview
- Don't use `<folder>` for Vue / React projects: .vue / .jsx files aren't compiled, so the page will be blank
- Add `--port 5600` to choose a port, or just ask in plain words: "Start webToAgent and preview `<folder>`"

- Claude Code starts the preview server in the background and gives you the URL
- After you pick elements, write requests, and submit them in the browser, Claude Code lists the planned changes first and edits only after you confirm
- The page reloads automatically after the changes
- Requests are stored in the project's `.webtoagent/` folder; adding it to `.gitignore` is recommended
- Skill names must be lowercase, so the command is `/webtoagent`

### Vue / React projects

Projects with a dev server (Vite + Vue / React, etc.) use proxy mode, with no changes to the project config:

- If you already ran `npm run dev` yourself, pass the dev server URL with `--proxy` (e.g. `http://localhost:5173`)
- Open the URL webToAgent gives you (default `http://127.0.0.1:5600/`), not the dev server's own URL
- Each request includes the component source file of the element (e.g. `src/components/MyButton.vue`); after the change, the dev server's HMR updates the page
- Vue projects get line numbers only with `vite-plugin-vue-devtools` installed; if it's missing, you'll be prompted at startup and Claude Code can install it for you
- Development mode only; React 19 doesn't expose line numbers, only the file and component name

## In the browser

| Action | How |
|------|------|
| Toggle pick mode | The "✎ Pick" button at the bottom right, or `Alt+Shift+E` |
| Select an element | Click an element in pick mode (a dashed outline means it's locked) |
| Save a request | Press `Enter` in the input box (`Shift+Enter` for a new line), or click "Save"; the element gets a green number |
| Insert a color | Click 🎨 at the bottom right of the input box: Tailwind projects show the palette (inserts `red-500`), daisyUI projects show theme colors (inserts `primary`), and the "General" tab lets you pick a color or sample one from the screen (inserts `#3b82f6`) |
| Edit / delete a saved request | Click a numbered element again; the panel shows its request, and you can "Update" or "Delete" it |
| Send to the CLI | Click "Submit (N)" at the bottom right to send all requests at once; pick mode turns off after a successful submit |
| Cancel | `Esc` unlocks the element; press `Esc` again to leave pick mode |
| Switch language | The "中" / "EN" button at the bottom right switches between Traditional Chinese and English |

- The UI language follows your browser (Chinese browsers get Traditional Chinese, others get English); once you switch, your choice is remembered
- The input box appears below the element by default, or above it when there isn't enough room; it repositions while scrolling and stays inside the viewport
- The queue is kept in `sessionStorage` (per tab), so it survives reloads and page changes; up to 50 requests per batch

## Security

- Runs only on local `127.0.0.1`, never exposed to the network
- Accepts requests only from the preview page itself; other websites can't submit
- Can read only files inside the preview folder
- Proxy mode forwards only to a local dev server (`localhost` / `127.0.0.1`)
