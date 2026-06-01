mod commands;
mod diff;
mod error;
mod fs_browse;
mod repo;
mod repo_library;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::open_repo,
            commands::compute_diff,
            commands::list_recent_repos,
            commands::forget_repo,
            commands::list_file_system_entries,
            commands::create_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
