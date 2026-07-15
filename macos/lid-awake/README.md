# LidAwake

MacBook の蓋（リッド）を閉じてもスリープさせないようにする、メニューバー常駐アプリです。メニューバーの ☕ アイコンから ON / OFF を切り替えられます。

*A macOS menu bar app that keeps your MacBook awake when the lid is closed. Toggle it from the ☕ icon in the menu bar. English notes are at the bottom.*

## 仕組み

macOS で「外部ディスプレイなしで蓋を閉じてもスリープさせない」を実現できる公式な手段は `pmset disablesleep` だけです。このアプリはトグル操作時に

```sh
pmset -a disablesleep 1   # 有効化（蓋を閉じてもスリープしない）
pmset -a disablesleep 0   # 無効化（通常のスリープ動作に戻す）
```

を管理者権限で実行します。root 権限が必要なため、**切り替えのたびにパスワード入力ダイアログが表示されます**（macOS の仕様です）。

- メニューを開くたびに `pmset -g` の `SleepDisabled` を読み直すので、ターミナル等で状態を変えてもチェック表示は実際の状態と同期します
- **アプリ終了時に、このアプリで有効化したスリープ抑止は自動的に解除されます**（切り忘れてカバンに入れてしまう事故の防止）

## 注意事項

- 有効中は蓋を閉じても Mac は動作し続けます。**バッテリー消費と発熱に注意**してください。特に密閉されたカバンへの収納は避けてください
- 電源メニューからの「スリープ」も抑止されます（`disablesleep` はシステム全体の設定です）
- macOS 13 (Ventura) 以降を想定しています

## ビルドと起動

Xcode Command Line Tools（`xcode-select --install`）があればビルドできます。

```sh
cd macos/lid-awake

# 開発時: そのまま実行（Ctrl+C で終了）
swift run

# 配布用: .app バンドルを作成
bash scripts/make-app.sh
open dist/LidAwake.app
```

`dist/LidAwake.app` を `/Applications` に移動すれば通常のアプリとして使えます。ログイン時に自動起動したい場合は「システム設定 → 一般 → ログイン項目」に追加してください。

## 使い方

1. アプリを起動するとメニューバーに ☕ アイコンが表示されます（Dock には表示されません）
2. アイコンをクリックし「**蓋を閉じてもスリープさせない**」を選択
3. 管理者パスワードを入力すると有効化され、アイコンが塗りつぶし表示（チェックマーク付き）になります
4. もう一度選択すると無効化されます
5. 「LidAwake を終了」で終了します（有効中なら自動でスリープ設定を元に戻します）

## English summary

- Toggling runs `pmset -a disablesleep 1|0` with administrator privileges (password prompt each time — required because the setting is root-only).
- The checkbox re-syncs with the real `pmset -g` state every time the menu opens.
- Quitting the app automatically restores normal sleep if the app enabled the override.
- While enabled the Mac stays awake with the lid closed — mind battery drain and heat, and never stow it in a bag.
- Build: `swift run` for development, `bash scripts/make-app.sh` to produce `dist/LidAwake.app` (macOS 13+, Xcode Command Line Tools required).
