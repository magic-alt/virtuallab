//! Bounded native protocol records, including streams without newlines.
use std::io::{self, BufRead, BufReader, Read};
pub(crate) const MAX_AGENT_LINE_BYTES: usize = 128 * 1024;
pub(crate) fn bounded_lines(reader: impl Read, limit: usize) -> impl Iterator<Item = io::Result<String>> {
    let mut reader = BufReader::new(reader);
    let mut failed = false;
    std::iter::from_fn(move || {
        if failed { return None; }
        let mut record = Vec::new();
        let mut oversized = false;
        loop {
            let chunk = match reader.fill_buf() {
                Ok(chunk) => chunk,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => { failed = true; return Some(Err(error)); },
            };
            if chunk.is_empty() {
                if oversized { return Some(Err(io::Error::new(io::ErrorKind::InvalidData, "Agent record exceeds byte limit"))); }
                if record.is_empty() { return None; }
                break;
            }
            let newline = chunk.iter().position(|byte| *byte == b'\n');
            let length = newline.unwrap_or(chunk.len());
            if !oversized {
                if length > limit.saturating_add(1).saturating_sub(record.len()) {
                    oversized = true;
                    record.clear();
                } else { record.extend_from_slice(&chunk[..length]); }
            }
            reader.consume(length + usize::from(newline.is_some()));
            if newline.is_some() { break; }
        }
        if oversized { return Some(Err(io::Error::new(io::ErrorKind::InvalidData, "Agent record exceeds byte limit"))); }
        if record.last() == Some(&b'\r') { record.pop(); }
        if record.len() > limit { return Some(Err(io::Error::new(io::ErrorKind::InvalidData, "Agent record exceeds byte limit"))); }
        Some(String::from_utf8(record).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)))
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_record_is_rejected_and_next_record_survives() {
        let input = b"123456789\nokay\r\n";
        let mut lines = bounded_lines(&input[..], 4);
        assert_eq!(lines.next().unwrap().unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(lines.next().unwrap().unwrap(), "okay");
        assert!(lines.next().is_none());
    }
    #[test]
    fn newline_free_stream_is_rejected_without_retaining_it() {
        let mut lines = bounded_lines(io::repeat(b'x').take(1024 * 1024), 4);
        assert_eq!(lines.next().unwrap().unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert!(lines.next().is_none());
    }
    #[test]
    fn invalid_utf8_record_does_not_discard_following_record() {
        let mut lines = bounded_lines(&b"\xff\nok\n"[..], 4);
        assert!(lines.next().unwrap().is_err());
        assert_eq!(lines.next().unwrap().unwrap(), "ok");
    }
    #[test]
    fn io_failure_is_reported_once() {
        struct Broken;
        impl Read for Broken { fn read(&mut self, _: &mut [u8]) -> io::Result<usize> { Err(io::Error::other("fixture")) } }
        let mut lines = bounded_lines(Broken, 4);
        assert!(lines.next().unwrap().is_err());
        assert!(lines.next().is_none());
    }
    #[test]
    fn preserves_utf8_empty_records_and_final_unterminated_record() {
        let input = "中\n\nlast";
        assert_eq!(bounded_lines(input.as_bytes(), 4).collect::<io::Result<Vec<_>>>().unwrap(), ["中", "", "last"]);
    }
}
