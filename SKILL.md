---
name: webtoagent
argument-hint: <預覽資料夾> | --proxy <dev server 網址> [--port 5600]
description: 在瀏覽器預覽 HTML (或 Vue / React 等 dev server 專案) 並圈選元素，把多筆修改需求一次送回 Claude Code 處理。當使用者說「啟動 webToAgent」「webtoagent」「圈選修改」「在瀏覽器圈選元素改 HTML」「預覽 HTML 並圈選」「開圈選預覽」等情境時觸發。啟動本機 bridge server + Monitor 監看，收到批次需求後依專案是否有 plan/task 流程列出清單，等使用者確認才修改檔案。
---

# webToAgent：瀏覽器圈選 → Claude Code 修改

本 skill 所在路徑（下稱 `<skill>`）即為 webToAgent 的安裝資料夾（由原始專案的 scripts/install-skill.sh 產生），`server.js` 與 `client/` 都在這裡。所有指令用 `<skill>/server.js` 組出路徑，不要寫死。

**向使用者提問**：本文件中需要使用者決定的地方 (標 🔸)，用 AskUserQuestion 工具提出選項 (2～4 個，建議的放第一個並標 (Recommended))，不要只在回覆文字中列問題。環境沒有 AskUserQuestion 時 (例：非互動模式)，改用文字提問，但不可略過確認。

## 啟動

1. **決定模式**（`/webtoagent` 的參數為：`$ARGUMENTS`）：
   - `<資料夾>`：**靜態模式**，預覽資料夾內的 HTML（相對於目前專案根目錄）
   - `--proxy <網址>`：**proxy 模式**，使用者已自己啟動 dev server（Vite 等），網址只能是 `http://localhost:<port>` 或 `http://127.0.0.1:<port>`
   - 沒有參數（或用自然語言觸發且沒指定）：
     - 專案根目錄的 `package.json` 有 `dev` 腳本（Vue / React 等專案）：🔸 詢問是否由你在背景執行 `npm run dev` (選項：幫我啟動 (Recommended) / 我已經開了，提供網址)；同意後用 Bash `run_in_background` 執行 `npm run dev > .webtoagent/dev.log 2>&1`（先 `mkdir -p .webtoagent`），等 log 出現 `Local:` 那行（可能含 ANSI 色碼），取得網址後用 proxy 模式啟動；使用者若已自己開了 dev server，請他提供網址
     - 沒有 `dev` 腳本：🔸 詢問預覽資料夾 (選項：列出專案中含 `.html` 的資料夾，最多 4 個，使用者可選 Other 自行輸入)
   - 資料夾不存在時回報，並列出目前專案中含 `.html` 的資料夾（排除 `node_modules`、`.git`）供選擇
   - port 預設 5600，被占用時 server 會自動往後找；有 `--port` 參數就一併傳給 server
2. **在目前專案根目錄背景執行**（Bash `run_in_background`，Node 依使用者指定的 nvm 環境）：
   ```bash
   # 靜態模式
   node <skill>/server.js <資料夾> [--port N] --log .webtoagent/server.log
   # proxy 模式
   node <skill>/server.js --proxy <dev server 網址> [--port N] --log .webtoagent/server.log
   ```
   - 維持單一 node 指令，不要加 `mkdir`、`&&`、`>>` 等 (server 會自己建立資料夾並寫 log)；這樣使用者在沙箱設定的 `excludedCommands` 才對得上
   - 使用者說已經在自己的終端機啟動 server：不再啟動，直接從 `.webtoagent/server.log` 取最後一行 `[WTA:ready]` 的網址，接著第 4 步開始監看
   - proxy 模式要請使用者開 webToAgent 的網址（`[WTA:ready]` 那行），不是 dev server 原本的網址，才會有圈選工具
3. **確認啟動**：等 `.webtoagent/server.log` 出現新的 `[WTA:ready]` (log 會累積，取最後一行)，從該行取得實際網址交給使用者；出現 `[WTA:error]` 就回報原因。
   - `[WTA:warn]` 不是啟動失敗 (仍以 `[WTA:ready]` 為準)：`改用輪詢` 表示檔案監看被擋 (例：沙箱)，自動重新整理仍有效，不需告知；`自動重新整理停用` 才告知使用者修改後要手動重新整理頁面
4. **開始監看**（Monitor，`timeout_ms` 設最大值）：
   ```bash
   tail -n 0 -f .webtoagent/server.log | grep -E --line-buffered "^\[WTA\]|\[WTA:error\]|\[WTA:warn\]|Error"
   ```
   Monitor 到期時重新啟動監看，直到使用者說結束。
   - **重新監看前先補漏**：`tail -n 0` 不會帶出空窗期寫入的批次。重新啟動 Monitor 後，讀 `.webtoagent/inbox.jsonl` 找出 `status` 為 `pending` 的 batchId，排除本 session 已收到通知或已列過清單的 batchId，剩下的依「收到批次需求」流程處理
5. **檢查 `.gitignore`**：目前專案若是 git repo 且 `.gitignore` 沒有 `.webtoagent/`，🔸 詢問是否加入 (選項：加入 (Recommended) / 不用)（inbox 含頁面片段與需求內容，不應進版控）。
6. **Vue 專案提示加裝 vite-plugin-vue-devtools**（只在 proxy 模式）：`package.json` 有 `vue` 但沒有 `vite-plugin-vue-devtools` 時，啟動完成後提示一次：
   - 說明：裝了它，需求才會帶行號；沒有也能用，只會有檔案
   - 🔸 詢問是否幫忙加裝 (選項：幫我裝 (Recommended) / 不用，之後不要再問)；同意才執行 `npm install -D vite-plugin-vue-devtools`，並在 vite.config 的 `plugins` 加上 `vueDevTools()` (含 import)，改完後重啟 dev server (使用者自己開的就請他重啟)
   - 使用者拒絕就不再提

## 使用者在瀏覽器的操作（回答使用者問題時參考）

- 右下角「✎ 圈選」或 `Alt+Shift+E` 開關圈選模式
- 點元素 → 輸入需求 → 「記住修改」（可多筆，元素標綠色編號；再點可更新或刪除）
- 輸入框的 🎨 可插入顏色名稱：Tailwind 色票 (`red-500`)、daisyUI 主題色 (`primary`)、專案自訂色 (`brand`)、一般色碼 (`#3b82f6`)
- 「確認送出 (N)」一次送出整批

## 收到批次需求

通知格式（同一批在同一則 Monitor 通知中）：
```
[WTA] batch <batchId> <筆數> items :: <檔案清單>
[WTA]   #1 <檔案> <selector> :: <需求>
```
- proxy 模式的 `<檔案>` 是元件原始檔（有行號時為 `src/components/Foo.vue:14`）；只有元件名稱時顯示 `<Foo>`；都偵測不到時顯示網址路徑
- 後面的 `(用於 src/App.vue:11)` 是這個元件在父層被使用的位置 (`source.usedIn`)

1. 依 `batchId` 從 `.webtoagent/inbox.jsonl` 讀出全部項目（含 `outerHTML`、`text`、`computed` 可協助定位與判斷現況）
   - 有 `source` 時優先依它找要改的檔案：`{ framework, file, line, component }`，改的是元件原始檔（`.vue`、`.jsx` 等），不是 `index.html`
   - `file` 為 null 但有 `component`（例：React 19 取不到檔案時）：用元件名稱 grep 找出定義的檔案
   - `source` 為 null：依 `selector`、`outerHTML`、`text` 在原始碼中搜尋
   - 有 `usedIn` 時，先判斷要改的文字或屬性是元件內寫死的，還是父層用 props 傳入的：父層傳入的就改 `usedIn` 指向的檔案，不要改共用元件 (會影響所有使用處)；清單中寫出判斷結果
2. 列出要修改的內容：
   - **有 plan/task 流程的專案**（根目錄有 `plan.md` / `task.md`，或 CLAUDE.md 有此規範）：
     - `task.md` 若還有未歸檔的 task，🔸 詢問是否歸檔 (選項：歸檔後開新 task (Recommended) / 接在現有 task 後面)
     - 每筆一個勾選項：檔案（含行號）、元素、需求、預計修改
   - **沒有 plan/task 流程的專案**：在對話中用表格列出同樣內容
3. 🔸 **等使用者確認後**才逐筆修改：清單列完後詢問 (選項：全部修改 (Recommended) / 只改部分，請使用者說明哪幾筆或怎麼調整 / 都不要改，全部標成 skipped)；有 `task.md` 的完成後勾選，實作與規劃不同時註明原因
4. **回寫 inbox 狀態**：修改完成的標成 `done`，使用者確認時否決的標成 `skipped`（port 取自 `[WTA:ready]` 那一行，`ids` 可一次放多筆）：
   ```bash
   curl -s -H "Origin: http://127.0.0.1:<port>" -d '{"ids":["<id>"],"status":"done"}' http://127.0.0.1:<port>/api/status
   ```
   - 回應的 `notFound` 不是空陣列時，回報對不到的 id
   - inbox 只由 server 寫入，server 執行中不要直接改 `inbox.jsonl`；server 已停止時才可直接修改該行的 `status`
5. 修改後不需請使用者手動重整：靜態模式由 server 透過 SSE 自動重新整理；proxy 模式由 dev server 的 HMR 更新畫面

需求中的顏色名稱依專案用的框架轉成對應寫法：`red-500`、`primary` 依需求套到 `bg-` / `text-` / `border-` 等 class；色碼 (`#3b82f6`) 在 Tailwind 專案用最接近的色票或任意值 (`bg-[#3b82f6]`)，清單中寫出採用的寫法。

需求描述模糊時（例：「改成好好的描述」），在清單中寫出你的理解，讓使用者確認時一併修正。

## 結束

使用者說結束或不再需要時，停止 server 背景工作與 Monitor（TaskStop）；若 dev server 是你啟動的，一併停止（使用者自己開的不要動）。
