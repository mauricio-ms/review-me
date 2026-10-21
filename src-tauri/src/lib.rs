mod branches;
mod commands;
mod commits;
mod coverage;
mod diff;
mod error;
mod fs_browse;
mod fuzzy;
mod queries;
mod repo;
mod repo_library;
mod review_commit;
mod review_dir;
mod revision;
mod tags;
mod tree;
mod xref;
#[cfg(test)]
mod xref_validate;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::open_repo,
            commands::compute_diff,
            commands::list_branches,
            commands::list_commits,
            commands::commit_reviews,
            commands::resolve_commit,
            commands::list_recent_repos,
            commands::forget_repo,
            commands::list_file_system_entries,
            commands::create_directory,
            commands::read_file,
            commands::load_tags,
            commands::add_reviewed_tag,
            commands::add_flag_tag,
            commands::add_ignored_tag,
            commands::set_flag_note,
            commands::remove_tag,
            commands::clear_tags,
            commands::unmark_range,
            commands::reviewed_commit_preflight,
            commands::prepare_reviewed_commit,
            commands::abort_reviewed_commit,
            commands::commit_reviewed_changes,
            commands::fuzzy_files,
            commands::list_repo_dir,
            commands::build_symbol_index,
            commands::symbol_at,
            commands::find_definition,
            commands::find_references,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
