//! The first ConPTY cursor query belongs to its startup transport, not the UI.
#[derive(Default)]
pub(crate) struct StartupCursorQuery {
    pending: Vec<u8>,
    answered: bool,
}
impl StartupCursorQuery {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> (Vec<u8>, bool) {
        if self.answered { return (chunk.to_vec(), false); }
        const QUERY: &[u8] = b"\x1b[6n";
        self.pending.extend_from_slice(chunk);
        if let Some(index) = self.pending.windows(QUERY.len()).position(|bytes| bytes == QUERY) {
            self.pending.drain(index..index + QUERY.len());
            self.answered = true;
            return (std::mem::take(&mut self.pending), true);
        }
        // Retain only an incomplete query prefix, never ordinary prompt text.
        let keep = (1..QUERY.len()).rev().find(|&size| self.pending.ends_with(&QUERY[..size])).unwrap_or(0);
        let rest = self.pending.split_off(self.pending.len() - keep);
        (std::mem::replace(&mut self.pending, rest), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consumes_only_the_startup_query_across_every_read_boundary() {
        for split in 0..=4 {
            let mut query = StartupCursorQuery::default();
            let mut output = Vec::new();
            let mut replies = 0;
            for chunk in [&b"\x1b[6n"[..split], &b"\x1b[6n"[split..], b"prompt\x1b[6n"] {
                let (bytes, reply) = query.push(chunk);
                output.extend(bytes); replies += usize::from(reply);
            }
            assert_eq!(output, b"prompt\x1b[6n");
            assert_eq!(replies, 1);
        }
    }
    #[test]
    fn preserves_text_and_other_escape_sequences_before_the_query() {
        let mut query = StartupCursorQuery::default();
        assert_eq!(query.push(b"ready\x1b[32m"), (b"ready\x1b[32m".to_vec(), false));
        assert_eq!(query.push(b"\x1b[6"), (vec![], false));
        assert_eq!(query.push(b"noops"), (b"oops".to_vec(), true));
    }
}
