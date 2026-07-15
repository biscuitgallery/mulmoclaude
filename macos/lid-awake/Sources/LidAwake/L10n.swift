import Foundation

/// Minimal ja/en string table. The app follows the system's preferred language;
/// anything other than Japanese falls back to English.
enum L10n {
    private static let isJapanese = Locale.preferredLanguages.first?.hasPrefix("ja") ?? false

    static var toggleTitle: String {
        isJapanese ? "蓋を閉じてもスリープさせない" : "Keep Awake When Lid Is Closed"
    }

    static var quitTitle: String {
        isJapanese ? "LidAwake を終了" : "Quit LidAwake"
    }

    static var batteryWarning: String {
        isJapanese
            ? "有効中は蓋を閉じてもスリープしません（バッテリー消費と発熱に注意）"
            : "While enabled, the Mac stays awake with the lid closed (watch battery and heat)"
    }

    static var authPrompt: String {
        isJapanese
            ? "スリープ設定の変更には管理者権限が必要です。"
            : "Changing the sleep setting requires administrator privileges."
    }

    static var errorTitle: String {
        isJapanese ? "スリープ設定を変更できませんでした" : "Could not change the sleep setting"
    }
}
