# webToAgent

在瀏覽器圈選 HTML 元素，記住多筆修改需求後一次送到 CLI Agent（Claude Code）處理，修改完成後頁面自動重新整理。

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

在任何專案的 Claude Code 中輸入 `/webtoagent <資料夾> [--port 5600]`，或說「啟動 webToAgent 預覽 `<資料夾>`」。

- Claude Code 會在背景啟動預覽 server，並給你網址
- 在瀏覽器圈選元素、寫下需求、確認送出後，Claude Code 會先列出修改清單，等你確認才修改
- 改完後頁面自動重新整理
- 需求紀錄存在該專案的 `.webtoagent/`，建議加入 `.gitignore`
- skill 名稱規定只能用小寫，所以指令是 `/webtoagent`

## 瀏覽器操作

| 動作 | 方式 |
|------|------|
| 開關圈選模式 | 右下角「✎ 圈選」按鈕，或 `Alt+Shift+E` |
| 選取元素 | 圈選模式下點擊元素（外框變虛線即鎖定） |
| 記住修改 | 輸入框按 `Enter`（`Shift+Enter` 換行），或按「記住修改」；元素標上綠色編號 |
| 修改 / 刪除已記住的項目 | 再點一次有編號的元素，面板帶出原內容，可「更新修改」或「刪除」 |
| 送到 CLI | 按右下角「確認送出 (N)」，全部項目一次送出 |
| 取消 | `Esc` 取消鎖定，再按一次 `Esc` 離開圈選模式 |

- 輸入框預設出現在元素下方；下方空間不足時改放上方，捲動時會跟著重新定位，並維持在視窗內
- 待送清單存在 `sessionStorage`（同一分頁內有效），頁面重新整理或切換頁面都不會遺失，單批上限 50 筆

## 安全

- 只在本機 `127.0.0.1` 執行，不對外網路開放
- 只接受預覽頁面本身送出的需求，其他網站無法送出
- 只能讀取預覽資料夾內的檔案
