#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if virtuallab_lib::maybe_handle_helper() { return; }
    virtuallab_lib::run();
}
