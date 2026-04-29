//! Tray icon state management. Updates icon based on RecorderState.

use tauri::AppHandle;
use tauri::Manager;
use tauri::image::Image;
use tracing::warn;

use crate::state_machine::RecorderState;

pub fn icon_path_for(state: RecorderState) -> &'static str {
    match state {
        RecorderState::Idle       => "icons/tray/tray-idle.png",
        RecorderState::Potential  => "icons/tray/tray-potential.png",
        RecorderState::Recording  => "icons/tray/tray-recording.png",
        RecorderState::Finalizing => "icons/tray/tray-finalizing.png",
    }
}

pub fn update_tray_for_state(app: &AppHandle, state: RecorderState) {
    let path = icon_path_for(state);
    let resolved = app.path().resolve(path, tauri::path::BaseDirectory::Resource);
    match resolved {
        Ok(p) => match Image::from_path(&p) {
            Ok(img) => {
                if let Some(tray) = app.tray_by_id("main") {
                    if let Err(e) = tray.set_icon(Some(img)) {
                        warn!("Failed to set tray icon: {}", e);
                    }
                }
            }
            Err(e) => warn!("Failed to load tray icon image {}: {}", path, e),
        },
        Err(e) => warn!("Failed to resolve tray icon path {}: {}", path, e),
    }
}
