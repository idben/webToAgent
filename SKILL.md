---
name: webtoagent
argument-hint: <預覽資料夾> [--port 5600]
description: 在瀏覽器預覽 HTML 並圈選元素，把多筆修改需求一次送回 Claude Code 處理。當使用者說「啟動 webToAgent」「webtoagent」「圈選修改」「在瀏覽器圈選元素改 HTML」「預覽 HTML 並圈選」「開圈選預覽」等情境時觸發。啟動本機 bridge server + Monitor 監看，收到批次需求後依專案是否有 plan/task 流程列出清單，等使用者確認才修改檔案。
---

# webToAgent：瀏覽器圈選 → Claude Code 修改

本 skill 所在路徑（下稱 `<skill>`）即為 webToAgent 的安裝資料夾（由原始專案的 scripts/install-skill.sh 產生），`server.js` 與 `client/` 都在這裡。所有指令用 `<skill>/server.js` 組出路徑，不要寫死。

## 啟動

1. **確認預覽資料夾**：
   - 以 `/webtoagent <資料夾> [--port N]` 呼叫時，參數為：`$ARGUMENTS`
   - 參數有資料夾就直接使用（相對於目前專案根目錄）；沒有參數，或使用者是用自然語言觸發且沒指定，才詢問
   - 資料夾不存在時回報，並列出目前專案中含 `.html` 的資料夾（排除 `node_modules`、`.git`）供選擇
   - port 預設 5600，被占用時 server 會自動往後找；有 `--port` 參數就一併傳給 server
2. **在目前專案根目錄背景執行**（Bash `run_in_background`，Node 依使用者指定的 nvm 環境）：
   ```bash
   mkdir -p .webtoagent && node <skill>/server.js <資料夾> [--port N] >> .webtoagent/server.log 2>&1
   ```
3. **確認啟動**：等 `.webtoagent/server.log` 出現 `[WTA:ready]`，從該行取得實際網址交給使用者；出現 `[WTA:error]` 就回報原因。
4. **開始監看**（Monitor，`timeout_ms` 設最大值）：
   ```bash
   tail -n 0 -f .webtoagent/server.log | grep -E --line-buffered "^\[WTA\]|\[WTA:error\]|Error"
   ```
   Monitor 到期時重新啟動監看，直到使用者說結束。
5. **檢查 `.gitignore`**：目前專案若是 git repo 且 `.gitignore` 沒有 `.webtoagent/`，詢問是否加入（inbox 含頁面片段與需求內容，不應進版控）。

## 使用者在瀏覽器的操作（回答使用者問題時參考）

- 右下角「✎ 圈選」或 `Alt+Shift+E` 開關圈選模式
- 點元素 → 輸入需求 → 「記住修改」（可多筆，元素標綠色編號；再點可更新或刪除）
- 「確認送出 (N)」一次送出整批

## 收到批次需求

通知格式（同一批在同一則 Monitor 通知中）：
```
[WTA] batch <batchId> <筆數> items :: <檔案清單>
[WTA]   #1 <檔案> <selector> :: <需求>
```

1. 依 `batchId` 從 `.webtoagent/inbox.jsonl` 讀出全部項目（含 `outerHTML`、`text`、`computed` 可協助定位與判斷現況）
2. 列出要修改的內容：
   - **有 plan/task 流程的專案**（根目錄有 `plan.md` / `task.md`，或 CLAUDE.md 有此規範）：
     - `task.md` 若還有未歸檔的 task，先詢問是否歸檔，歸檔後再開新的 `task.md`
     - 每筆一個勾選項：檔案（含行號）、元素、需求、預計修改
   - **沒有 plan/task 流程的專案**：在對話中用表格列出同樣內容
3. **等使用者確認後**才逐筆修改；有 `task.md` 的完成後勾選，實作與規劃不同時註明原因
4. **回寫 inbox 狀態**：修改完成的標成 `done`，使用者確認時否決的標成 `skipped`（port 取自 `[WTA:ready]` 那一行，`ids` 可一次放多筆）：
   ```bash
   curl -s -H "Origin: http://127.0.0.1:<port>" -d '{"ids":["<id>"],"status":"done"}' http://127.0.0.1:<port>/api/status
   ```
   - 回應的 `notFound` 不是空陣列時，回報對不到的 id
   - inbox 只由 server 寫入，server 執行中不要直接改 `inbox.jsonl`；server 已停止時才可直接修改該行的 `status`
5. 修改預覽資料夾內的檔案後，瀏覽器會透過 SSE 自動重新整理，不需請使用者手動重整

需求描述模糊時（例：「改成好好的描述」），在清單中寫出你的理解，讓使用者確認時一併修正。

## 結束

使用者說結束或不再需要時，停止 server 背景工作與 Monitor（TaskStop）。
