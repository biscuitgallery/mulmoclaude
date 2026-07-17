#!/bin/bash
# One-shot installer for LidAwake.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/biscuitgallery/mulmoclaude/claude/macos-lid-sleep-toggle-n2wmds/macos/lid-awake/install.sh | bash
# Clones the source, builds LidAwake.app, installs it to ~/Applications and launches it.
set -euo pipefail

REPO_URL="https://github.com/biscuitgallery/mulmoclaude.git"
BRANCH="claude/macos-lid-sleep-toggle-n2wmds"
APP_NAME="LidAwake"
INSTALL_DIR="$HOME/Applications"

if [ "$(uname)" != "Darwin" ]; then
  echo "エラー: このスクリプトは macOS 専用です" >&2
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "==> Xcode Command Line Tools が必要です。インストールダイアログを表示します..."
  xcode-select --install || true
  echo "==> ダイアログからインストールを完了させたあと、もう一度同じコマンドを実行してください。"
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> ソースコードを取得しています..."
git clone --quiet --depth 1 -b "$BRANCH" "$REPO_URL" "$WORK_DIR/src"

cd "$WORK_DIR/src/macos/lid-awake"
echo "==> ビルドしています（初回は数分かかることがあります）..."
bash scripts/make-app.sh

mkdir -p "$INSTALL_DIR"
pkill -x "$APP_NAME" 2>/dev/null || true
rm -rf "${INSTALL_DIR:?}/${APP_NAME}.app"
cp -R "dist/${APP_NAME}.app" "$INSTALL_DIR/"
echo "==> ${INSTALL_DIR}/${APP_NAME}.app にインストールしました"

open "${INSTALL_DIR}/${APP_NAME}.app"
echo "==> 起動しました。メニューバー右上の ☕ アイコンをクリックして操作してください。"
echo "    （アイコンが見えない場合はノッチの裏に隠れていないか、メニューバー管理アプリの設定をご確認ください）"
