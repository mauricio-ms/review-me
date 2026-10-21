use tauri::{App, WebviewWindowBuilder};

/// The window `tauri.conf.json` declares with `"create": false`, so it is built here,
/// where its decorations can depend on the desktop it opens on.
const MAIN: &str = "main";

/// `XDG_CURRENT_DESKTOP` names of compositors that tile windows and draw no title
/// bars. GTK 3 doesn't support xdg-decoration, so a decorated window on one of these
/// draws its own header bar inside the tile, duplicating the controls the
/// compositor's keybindings already provide.
const TILING_DESKTOPS: &[&str] = &["hyprland", "sway", "niri", "river", "i3"];

/// Overrides the guess: `1` always decorates, `0` never does.
const OVERRIDE_VAR: &str = "REVIEW_ME_DECORATIONS";

pub fn create_main(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .ok_or("tauri.conf.json declares no \"main\" window")?;
    let decorations = decorated(
        std::env::var(OVERRIDE_VAR).ok().as_deref(),
        std::env::var("XDG_CURRENT_DESKTOP").ok().as_deref(),
    );
    WebviewWindowBuilder::from_config(app.handle(), config)?
        .decorations(decorations)
        .build()?;
    Ok(())
}

/// Without a title bar a floating window can't be moved, minimised or closed with the
/// mouse, so decorations are on unless the desktop is a known tiling compositor.
/// `XDG_CURRENT_DESKTOP` is a colon-separated list (`ubuntu:GNOME`).
fn decorated(forced: Option<&str>, desktop: Option<&str>) -> bool {
    match forced.map(str::trim) {
        Some("1") => return true,
        Some("0") => return false,
        _ => {}
    }
    let tiling = desktop.unwrap_or("").split(':').any(|name| {
        TILING_DESKTOPS
            .iter()
            .any(|t| name.trim().eq_ignore_ascii_case(t))
    });
    !tiling
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floating_desktops_get_a_title_bar() {
        assert!(decorated(None, Some("ubuntu:GNOME")));
        assert!(decorated(None, Some("KDE")));
        assert!(decorated(None, Some("")));
        assert!(decorated(None, None));
    }

    #[test]
    fn tiling_compositors_do_not() {
        assert!(!decorated(None, Some("Hyprland")));
        assert!(!decorated(None, Some("sway")));
        assert!(!decorated(None, Some("niri:wlroots")));
    }

    #[test]
    fn the_override_wins_either_way() {
        assert!(decorated(Some("1"), Some("Hyprland")));
        assert!(!decorated(Some("0"), Some("ubuntu:GNOME")));
        assert!(!decorated(Some("yes"), Some("Hyprland")));
        assert!(decorated(Some(""), Some("GNOME")));
    }
}
