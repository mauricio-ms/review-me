//! JSON the way config files write it: `//` and `/* */` comments and trailing commas,
//! which `tsconfig.json` and `jsconfig.json` allow and `serde_json` doesn't.

use serde_json::Value;

pub fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(&strip(text)).ok()
}

/// The text with its comments and trailing commas taken out, strings left alone.
fn strip(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    // Where the last comma written sits in `out`, while only blanks and comments have
    // followed it: a `}` or `]` there makes it a trailing one.
    let mut pending_comma: Option<usize> = None;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'"' => {
                pending_comma = None;
                let start = i;
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    i += if bytes[i] == b'\\' { 2 } else { 1 };
                }
                i = (i + 1).min(bytes.len());
                out.push_str(&text[start..i]);
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
            }
            b',' => {
                pending_comma = Some(out.len());
                out.push(',');
                i += 1;
            }
            b'}' | b']' => {
                if let Some(at) = pending_comma.take() {
                    out.replace_range(at..at + 1, " ");
                }
                out.push(c as char);
                i += 1;
            }
            _ => {
                if !c.is_ascii_whitespace() {
                    pending_comma = None;
                }
                // Copy the whole character, however many bytes it takes.
                let len = text[i..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&text[i..i + len]);
                i += len;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_comments_and_trailing_commas() {
        let v = parse(
            "\u{feff}{\n  // the app\n  \"compilerOptions\": { /* aliases */ \"paths\": { \"@/*\": [\"./src/*\",], }, },\n  \"x\": \"a // not a comment, }\",\n}\n",
        )
        .unwrap();
        assert_eq!(v["compilerOptions"]["paths"]["@/*"][0], "./src/*");
        assert_eq!(v["x"], "a // not a comment, }");
    }

    #[test]
    fn rejects_what_is_not_json() {
        assert!(parse("{ nope").is_none());
    }
}
