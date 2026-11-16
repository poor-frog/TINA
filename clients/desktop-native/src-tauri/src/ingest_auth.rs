use anyhow::{bail, Result};
use ring::hmac;
use std::{env, fs, path::PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub fn read_secret() -> Result<String> {
    #[cfg(target_os = "windows")]
    let path = PathBuf::from(
        env::var_os("LOCALAPPDATA")
            .ok_or_else(|| anyhow::anyhow!("TINA Desktop auth is unavailable"))?,
    )
    .join("local.tina.capture/desktop-ingest-token");
    #[cfg(not(target_os = "windows"))]
    let path = PathBuf::from(
        env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("TINA Desktop auth is unavailable"))?,
    )
    .join("Library/Application Support/local.tina.capture/desktop-ingest-token");
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| anyhow::anyhow!("TINA Desktop auth is unavailable"))?;
    if !metadata.file_type().is_file() {
        bail!("TINA Desktop auth is unavailable");
    }
    if metadata.len() > 8192 {
        bail!("TINA Desktop auth is invalid");
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        bail!("TINA Desktop auth file permissions are not private");
    }
    let secret = fs::read_to_string(path)
        .map_err(|_| anyhow::anyhow!("TINA Desktop auth is unavailable"))?
        .trim()
        .to_string();
    #[cfg(target_os = "windows")]
    let secret = unprotect_secret(&secret)?;
    if decode_hex(&secret).is_none_or(|bytes| bytes.len() != 32) {
        bail!("TINA Desktop auth is invalid");
    }
    Ok(secret)
}

#[cfg(target_os = "windows")]
fn unprotect_secret(protected_hex: &str) -> Result<String> {
    use windows::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let mut bytes =
        decode_hex(protected_hex).ok_or_else(|| anyhow::anyhow!("TINA Desktop auth is invalid"))?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into()?,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| {
            anyhow::anyhow!("TINA Desktop auth could not be decrypted for this Windows user")
        })?;
        let value = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = String::from_utf8(value.to_vec());
        value.fill(0);
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        result.map_err(|_| anyhow::anyhow!("TINA Desktop auth is invalid"))
    }
}

pub fn verify_proof(secret_hex: &str, challenge: &str, proof_hex: &str) -> bool {
    let (Some(secret), Some(proof)) = (decode_hex(secret_hex), decode_hex(proof_hex)) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, &secret);
    hmac::verify(&key, challenge.as_bytes(), &proof).is_ok()
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digits = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(digits, 16).ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::verify_proof;

    #[test]
    fn verifies_the_server_proof_for_the_current_challenge() {
        let secret = "0b".repeat(20);
        let proof = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";

        assert!(verify_proof(&secret, "Hi There", proof));
        assert!(!verify_proof(&secret, "different challenge", proof));
        assert!(!verify_proof(&secret, "Hi There", "not a proof"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn node_protected_secret_can_be_read_by_the_windows_client() {
        use std::os::windows::process::CommandExt;
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .unwrap();
        let helper = root.join("deploy/compose/bin/desktop-local-platform.mjs");
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", "import {pathToFileURL} from 'node:url'; const {protectIngestSecret}=await import(pathToFileURL(process.argv[1])); process.stdout.write(protectIngestSecret('0b'.repeat(32))); "])
            .arg(helper).creation_flags(0x08000000).output().unwrap();
        assert!(output.status.success());
        let ciphertext = String::from_utf8(output.stdout).unwrap();
        assert_eq!(
            super::unprotect_secret(&ciphertext).unwrap(),
            "0b".repeat(32)
        );
        assert!(super::unprotect_secret(&"0b".repeat(32)).is_err());
    }
}
