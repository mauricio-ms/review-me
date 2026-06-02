mod commands;
mod diff;
mod error;
mod fs_browse;
mod fuzzy;
mod repo;
mod repo_library;
mod tags;
mod tree;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::open_repo,
            commands::compute_diff,
            commands::list_recent_repos,
            commands::forget_repo,
            commands::list_file_system_entries,
            commands::create_directory,
            commands::read_file,
            commands::load_tags,
            commands::save_tags,
            commands::add_reviewed_tag,
            commands::add_flag_tag,
            commands::remove_tag,
            commands::unreview_range,
            commands::fuzzy_files,
            commands::list_repo_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
