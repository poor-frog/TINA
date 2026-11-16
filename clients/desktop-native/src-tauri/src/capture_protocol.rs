pub(crate) fn audio_frame(
    channel: u32,
    name: &str,
    ts: f64,
    sample: Option<u64>,
    pcm: &[f32],
) -> Vec<u8> {
    let name = name.as_bytes();
    let padded = (name.len() + 3) & !3;
    let header = if sample.is_some() { 24 } else { 16 };
    let flags = if sample.is_some() {
        0xc0000000
    } else {
        0x80000000
    };
    let mut frame = Vec::with_capacity(header + padded + pcm.len() * 4);
    frame.extend_from_slice(&(channel | flags).to_le_bytes());
    frame.extend_from_slice(&ts.to_le_bytes());
    if let Some(index) = sample {
        frame.extend_from_slice(&(index as f64).to_le_bytes());
    }
    frame.extend_from_slice(&(name.len() as i32).to_le_bytes());
    frame.extend_from_slice(name);
    frame.resize(header + padded, 0);
    for value in pcm {
        frame.extend_from_slice(&value.to_le_bytes());
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::audio_frame;

    #[test]
    fn preserves_named_channels_sample_index_timestamp_and_pcm() {
        let frame = audio_frame(999, "System audio", 1234.5, Some(320), &[0.25, -0.5]);
        assert_eq!(
            u32::from_le_bytes(frame[..4].try_into().unwrap()),
            999 | 0xc0000000
        );
        assert_eq!(f64::from_le_bytes(frame[4..12].try_into().unwrap()), 1234.5);
        assert_eq!(f64::from_le_bytes(frame[12..20].try_into().unwrap()), 320.0);
        assert_eq!(i32::from_le_bytes(frame[20..24].try_into().unwrap()), 12);
        assert_eq!(&frame[24..36], b"System audio");
        assert_eq!(f32::from_le_bytes(frame[36..40].try_into().unwrap()), 0.25);
        assert_eq!(frame.len(), 44);
    }

    #[test]
    fn legacy_frame_pads_names_and_omits_sample_index() {
        let frame = audio_frame(1000, "You", 5.0, None, &[1.0]);
        assert_eq!(
            u32::from_le_bytes(frame[..4].try_into().unwrap()),
            1000 | 0x80000000
        );
        assert_eq!(i32::from_le_bytes(frame[12..16].try_into().unwrap()), 3);
        assert_eq!(&frame[16..20], b"You\0");
        assert_eq!(frame.len(), 24);
    }
}
