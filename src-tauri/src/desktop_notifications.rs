//! Non-modal, OS-managed desktop notifications. No shell subprocesses or dialogs.
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
pub fn desktop_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    // Never accept arbitrary long text or terminal escape payloads.
    if title.trim().is_empty() || title.len() > 100 || body.len() > 240 ||
       title.chars().any(char::is_control) || body.chars().any(char::is_control) {
        return Err("Invalid notification title or body".to_owned());
    }
    app.notification().builder().title(title).body(body).show()
        .map_err(|error| format!("Desktop notifications are unavailable: {error}"))
}
