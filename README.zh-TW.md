# webToAgent

[English](README.md) | 繁體中文

在瀏覽器圈選 HTML 元素，記住多筆修改需求後一次送到 CLI Agent（Claude Code）處理，修改完成後頁面自動重新整理。

[![webToAgent demo](https://img.youtube.com/vi/w7ge1LemSP8/hqdefault.jpg)](https://youtu.be/w7ge1LemSP8)

▶ [示範操作影片](https://youtu.be/w7ge1LemSP8)

## 從 GitHub 安裝

需要 Node.js 20 以上、git、bash (macOS 或 Windows 的 WSL)，以及 Claude Code。零相依套件，不需要 `npm install`。

### 讓 Claude Code 幫你裝

在 Claude Code 中貼上：

```text
請照 https://github.com/idben/webToAgent 的 README 安裝 webToAgent skill
```

### 自己安裝

```bash
git clone https://github.com/idben/webToAgent.git
cd webToAgent
scripts/install-skill.sh
```

- 安裝到 `~/.claude/skills/webtoagent`
- 更新：在 webToAgent 資料夾執行 `git pull`，再重新執行 `scripts/install-skill.sh`
- 移除：`rm -rf ~/.claude/skills/webtoagent`

## 在 Claude Code 中使用

依專案類型選擇用法：

| 專案 | 輸入 |
|---|---|
| 一般 HTML | `/webtoagent <資料夾>` |
| Vue / React 等有 dev server 的專案 | `/webtoagent`，或 `/webtoagent --proxy <dev server 網址>` |

- 不帶參數時，專案有 `dev` 腳本會詢問是否幫你啟動 dev server；沒有就詢問要預覽的資料夾
- Vue / React 專案不要用 `<資料夾>`：不會編譯 .vue / .jsx，畫面會是空白
- 可加 `--port 5600` 指定 port，也可以用說的：「啟動 webToAgent 預覽 `<資料夾>`」

- Claude Code 會在背景啟動預覽 server，並給你網址
- 在瀏覽器圈選元素、寫下需求、確認送出後，Claude Code 會先列出修改清單，等你確認才修改
- 改完後頁面自動重新整理
- 需求紀錄存在該專案的 `.webtoagent/`，建議加入 `.gitignore`
- skill 名稱規定只能用小寫，所以指令是 `/webtoagent`

### Vue / React 專案

有 dev server 的專案（Vite + Vue / React 等）用 proxy 模式，不用改專案設定：

- 已經自己執行 `npm run dev` 時，用 `--proxy` 帶入 dev server 網址 (例：`http://localhost:5173`)
- 請開 webToAgent 給的網址（預設 `http://127.0.0.1:5600/`），不是 dev server 原本的網址
- 需求會附上元素所在的元件原始檔（例：`src/components/MyButton.vue`），改完由 dev server 的 HMR 更新畫面
- Vue 專案裝了 `vite-plugin-vue-devtools` 才有行號，沒裝時啟動會提示，可以讓 Claude Code 幫你加裝
- 只支援開發模式；React 19 取不到行號，只有檔案與元件名稱

## 瀏覽器操作

| 動作 | 方式 |
|------|------|
| 開關圈選模式 | 右下角「✎ 圈選」按鈕，或 `Alt+Shift+E` |
| 選取元素 | 圈選模式下點擊元素（外框變虛線即鎖定） |
| 記住修改 | 輸入框按 `Enter`（`Shift+Enter` 換行），或按「記住修改」；元素標上綠色編號 |
| 插入顏色 | 輸入框右下角 🎨：有用 Tailwind 會出現色票 (插入 `red-500`)，有用 daisyUI 會出現主題色 (插入 `primary`)，「一般」分頁可自選或吸取畫面顏色 (插入 `#3b82f6`) |
| 修改 / 刪除已記住的項目 | 再點一次有編號的元素，面板帶出原內容，可「更新修改」或「刪除」 |
| 送到 CLI | 按右下角「確認送出 (N)」，全部項目一次送出，送出成功後自動退出圈選模式 |
| 取消 | `Esc` 取消鎖定，再按一次 `Esc` 離開圈選模式 |
| 切換語言 | 右下角「中」/「EN」按鈕，切換正體中文與英文介面 |

- 介面語言預設跟著瀏覽器 (中文瀏覽器顯示正體中文，其他顯示英文)，手動切換後會記住
- 輸入框預設出現在元素下方；下方空間不足時改放上方，捲動時會跟著重新定位，並維持在視窗內
- 待送清單存在 `sessionStorage`（同一分頁內有效），頁面重新整理或切換頁面都不會遺失，單批上限 50 筆

## 在沙箱中使用

- Claude Code 沙箱擋住檔案監看時，server 會改成每秒掃描預覽資料夾，自動重新整理照常有效 (資料夾超過 5000 個檔案時停止掃描，需手動重新整理)
- server 只印出預覽網址，請自己在瀏覽器開啟
- server 需要使用沙箱允許的本機 port (預設 5600，或用 `--port` 指定)

## 安全

- 只在本機 `127.0.0.1` 執行，不對外網路開放
- 只接受預覽頁面本身送出的需求，其他網站無法送出
- 只能讀取預覽資料夾內的檔案
- Host 不是 `127.0.0.1` / `localhost` 的請求一律拒絕，防止 DNS 重綁定 (DNS rebinding) 攻擊
- proxy 模式只能轉送到本機（`localhost` / `127.0.0.1`）的 dev server
