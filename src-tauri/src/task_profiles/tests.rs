use super::*;
use serde_json::json;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("vl-profiles-{}", crate::tasks::new_id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> PathBuf {
        self.0.join("profiles.json")
    }
    fn manager(&self) -> TaskProfileLibrary {
        TaskProfileLibrary::open(self.path()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn profile(id: &str) -> Value {
    json!({"schemaVersion":1,"id":id,"name":"编译 Unicode","gates":[{"id":"build","label":"Build","kind":"build","required":true,"approval":"none","executor":{"type":"process","program":"npm","args":["run","build","two words","中文"],"cwd":"workspace"}}]})
}
fn save(m: &TaskProfileLibrary, id: &str, revision: Option<u64>) -> Result<ProfileRecord, String> {
    m.save(SaveProfileRequest {
        profile: profile(id),
        expected_revision: revision,
    })
}
#[test]
fn reopen_preserves_unicode_and_argv() {
    let f = Fixture::new();
    let m = f.manager();
    assert!(m.list().unwrap().is_empty());
    let record = save(&m, "checks", None).unwrap();
    assert_eq!(record.revision, 1);
    assert_eq!(f.manager().list().unwrap()[0].profile, profile("checks"));
    assert_eq!(save(&m, "checks", Some(1)).unwrap().revision, 2);
}
#[test]
fn stale_create_and_unknown_update_preserve_disk() {
    let f = Fixture::new();
    let m = f.manager();
    save(&m, "checks", None).unwrap();
    let before = fs::read(f.path()).unwrap();
    assert!(save(&m, "checks", None).is_err());
    assert!(save(&m, "checks", Some(2)).is_err());
    assert!(save(&m, "new", Some(1)).is_err());
    assert_eq!(fs::read(f.path()).unwrap(), before);
    assert_eq!(m.list().unwrap()[0].revision, 1);
    assert_eq!(save(&m, "copy", None).unwrap().revision, 1);
}
#[test]
fn cloned_writers_have_exactly_one_winner() {
    let f = Fixture::new();
    let m = f.manager();
    save(&m, "checks", None).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let handles = (0..2)
        .map(|_| {
            let m = m.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                save(&m, "checks", Some(1)).is_ok()
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    assert_eq!(
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .filter(|ok| *ok)
            .count(),
        1
    );
    assert_eq!(f.manager().list().unwrap()[0].revision, 2);
}
#[test]
fn corrupt_and_unsupported_generations_are_preserved() {
    let f = Fixture::new();
    for bytes in [
        b"bad".to_vec(),
        br#"{"schemaVersion":2,"records":[]}"#.to_vec(),
    ] {
        fs::write(f.path(), &bytes).unwrap();
        assert!(TaskProfileLibrary::open(f.path()).is_err());
        assert_eq!(fs::read(f.path()).unwrap(), bytes);
    }
}
#[test]
fn loaded_ids_revisions_and_duplicates_are_validated() {
    let f = Fixture::new();
    for (id, revision, duplicate) in [
        ("different", 1, false),
        ("checks", 0, false),
        ("checks", MAX_REVISION + 1, false),
        ("checks", 1, true),
    ] {
        let r = json!({"id":id,"revision":revision,"profile":profile("checks"),"updatedAtMs":1});
        let rows = if duplicate {
            vec![r.clone(), r]
        } else {
            vec![r]
        };
        let bytes = serde_json::to_vec(&json!({"schemaVersion":1,"records":rows})).unwrap();
        fs::write(f.path(), &bytes).unwrap();
        assert!(TaskProfileLibrary::open(f.path()).is_err());
        assert_eq!(fs::read(f.path()).unwrap(), bytes);
    }
}
#[test]
fn safe_integer_revision_does_not_overflow() {
    let f = Fixture::new();
    fs::write(f.path(),serde_json::to_vec(&json!({"schemaVersion":1,"records":[{"id":"checks","revision":MAX_REVISION,"profile":profile("checks"),"updatedAtMs":1}]})).unwrap()).unwrap();
    let m = f.manager();
    let before = fs::read(f.path()).unwrap();
    assert!(save(&m, "checks", Some(MAX_REVISION)).is_err());
    assert_eq!(fs::read(f.path()).unwrap(), before);
}
#[test]
fn bounds_invalid_program_secret_and_traversal_fail_before_publication() {
    let f = Fixture::new();
    let m = f.manager();
    let mut invalid = Vec::new();
    let mut p = profile("checks");
    p["gates"][0]["executor"]["program"] = json!("sh");
    invalid.push(p);
    for path in ["../src", ".env", ".git/config"] {
        let mut p = profile("checks");
        p["sourcePaths"] = json!([path]);
        invalid.push(p);
    }
    let mut p = profile("checks");
    p["name"] = json!("x".repeat(65537));
    invalid.push(p);
    for profile in invalid {
        assert!(m
            .save(SaveProfileRequest {
                profile,
                expected_revision: None
            })
            .is_err());
    }
    assert!(m.list().unwrap().is_empty());
}
#[test]
fn record_limit_and_oversized_file_are_bounded() {
    let f = Fixture::new();
    let m = f.manager();
    for i in 0..128 {
        save(&m, &format!("p{i}"), None).unwrap();
    }
    assert!(save(&m, "overflow", None).is_err());
    assert_eq!(m.list().unwrap().len(), 128);
    let g = Fixture::new();
    File::create(g.path())
        .unwrap()
        .set_len(MAX_BYTES as u64 + 1)
        .unwrap();
    assert!(TaskProfileLibrary::open(g.path()).is_err());
}
#[test]
fn failed_persistence_leaves_memory_unchanged() {
    let f = Fixture::new();
    let m = f.manager();
    save(&m, "checks", None).unwrap();
    fs::remove_file(f.path()).unwrap();
    fs::create_dir(f.path()).unwrap();
    assert!(save(&m, "checks", Some(1)).is_err());
    assert_eq!(m.list().unwrap()[0].revision, 1);
    assert!(f.path().is_dir());
}
#[test]
fn unavailable_service_and_nonregular_path_fail_closed() {
    let f = Fixture::new();
    fs::create_dir(f.path()).unwrap();
    assert!(TaskProfileLibrary::open(f.path()).is_err());
    let m = TaskProfileLibrary::unavailable("unavailable".into());
    assert!(m.list().is_err());
    assert!(save(&m, "checks", None).is_err());
}
#[cfg(unix)]
#[test]
fn symlink_is_refused_without_touching_target() {
    let f = Fixture::new();
    let target = f.0.join("original");
    fs::write(&target, "untouched").unwrap();
    std::os::unix::fs::symlink(&target, f.path()).unwrap();
    assert!(TaskProfileLibrary::open(f.path()).is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), "untouched");
}
