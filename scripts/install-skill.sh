#!/usr/bin/env bash
# 將 webToAgent 打包成全域 skill：複製必要檔案到 skill 資料夾，可選擇輸出 zip
# 用法：scripts/install-skill.sh [目標資料夾] [--zip]
set -euo pipefail

projectDir="$(cd "$(dirname "$0")/.." && pwd)"
target="$HOME/.claude/skills/webtoagent"
makeZip=false
marker=".webtoagent-skill"
files=(SKILL.md server.js package.json README.md README.zh-TW.md client)

for arg in "$@"; do
  case "$arg" in
    --zip) makeZip=true ;;
    -h|--help)
      echo "用法：scripts/install-skill.sh [目標資料夾] [--zip]"
      echo "  預設目標：~/.claude/skills/webtoagent"
      echo "  --zip    另外輸出 dist/webtoagent-<版本>.zip"
      exit 0
      ;;
    *) target="$arg" ;;
  esac
done

# 去掉結尾的 /：捷徑路徑帶 / 時 [ -L ] 會判成指向的資料夾，接著 rm -rf 會刪掉捷徑指向的內容
while [ "${target}" != "/" ] && [ "${target%/}" != "${target}" ]; do
  target="${target%/}"
done

for f in "${files[@]}"; do
  if [ ! -e "${projectDir}/${f}" ]; then
    echo "✗ 找不到 ${f}，請在 webToAgent 專案中執行" >&2
    exit 1
  fi
done

version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${projectDir}/package.json" | head -1)"
version="${version:-0.0.0}"

# 安全檢查：只覆蓋捷徑或由本腳本產生的資料夾
if [ -L "${target}" ]; then
  rm "${target}"
  echo "• 移除舊的捷徑：${target}"
elif [ -d "${target}" ]; then
  if [ ! -f "${target}/${marker}" ]; then
    echo "✗ ${target} 已存在且不是本腳本產生的（缺少 ${marker}），為避免誤刪已停止" >&2
    exit 1
  fi
  rm -rf "${target}"
elif [ -e "${target}" ]; then
  echo "✗ ${target} 已存在且不是資料夾，已停止" >&2
  exit 1
fi

mkdir -p "${target}"
for f in "${files[@]}"; do
  cp -R "${projectDir}/${f}" "${target}/"
done
cat > "${target}/${marker}" <<EOF
此資料夾由 webToAgent 的 scripts/install-skill.sh 產生，請勿直接修改。
修改請回到原始專案後重新執行腳本。
version: $version
source: $projectDir
installedAt: $(date '+%Y-%m-%d %H:%M:%S')
EOF

echo "✓ 已安裝 webtoagent skill v${version} → ${target}"
(cd "${target}" && find . -type f | sort | sed 's|^\./|  |')

if $makeZip; then
  distDir="${projectDir}/dist"
  zipFile="$distDir/webtoagent-${version}.zip"
  mkdir -p "$distDir"
  rm -f "${zipFile}"
  (cd "$(dirname "${target}")" && zip -qr "${zipFile}" "$(basename "${target}")" -x '*.DS_Store')
  echo "✓ 已輸出 ${zipFile}"
  echo "  其他電腦安裝：unzip $(basename "${zipFile}") -d ~/.claude/skills/"
fi
