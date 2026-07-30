// Phase 8 Task 5: suppress the console window in release builds. Without
// this attribute the Rust linker defaults to the `console` subsystem,
// which makes Windows auto-attach a terminal alongside the GUI — fine
// for development (logs visible) but visible to end users on the MSI.
// `cfg_attr(not(debug_assertions))` keeps the console for `cargo run`
// and `tauri dev` so the dev experience is unchanged.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use log;
use env_logger;

fn main() {
    std::env::set_var("RUST_LOG", "info");
    env_logger::init();
    log::info!("Starting application...");
    app_lib::run();
}
