//! Incremental UTF-8 decoding for stdout/stderr pipes. A read() can split
//! a multibyte character, so decoding each read with from_utf8_lossy is unsafe.
#[derive(Default)]
pub(crate) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    output.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_len = error.valid_up_to();
                    if valid_len > 0 {
                        output.push_str(std::str::from_utf8(&self.pending[..valid_len]).unwrap());
                        self.pending.drain(..valid_len);
                    }
                    if let Some(invalid_len) = error.error_len() {
                        output.push('\u{FFFD}');
                        self.pending.drain(..invalid_len);
                    } else {
                        // Retain only the incomplete multibyte suffix.
                        break;
                    }
                }
            }
        }
        output
    }

    pub(crate) fn finish(&mut self) -> String {
        let trailing = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        trailing
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8StreamDecoder;

    #[test]
    fn preserves_multibyte_text_across_chunk_boundaries() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push(&[b'A', 0xe4, 0xb8]), "A");
        assert_eq!(decoder.push(&[0xad, 0xf0, 0x9f]), "中");
        assert_eq!(decoder.push(&[0x94, 0xa7, b'!']), "🔧!");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn replaces_invalid_bytes_but_keeps_following_valid_text() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push(&[0xff, b'o', b'k']), "\u{FFFD}ok");
        assert_eq!(decoder.push(&[0xe4, 0xb8]), "");
        assert_eq!(decoder.finish(), "\u{FFFD}");
    }

    #[test]
    fn leaves_ansi_control_bytes_intact_for_the_ui_parser() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push(b"\x1b[32mPASS\x1b[0m"), "\x1b[32mPASS\x1b[0m");
        assert_eq!(decoder.finish(), "");
    }
}
